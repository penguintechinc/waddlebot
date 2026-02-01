import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'dart:convert';
import 'dart:developer' as developer;

/// Custom exception for API errors
class ApiError implements Exception {
  final String message;
  final int? statusCode;
  final String? errorCode;
  final dynamic originalError;

  ApiError({
    required this.message,
    this.statusCode,
    this.errorCode,
    this.originalError,
  });

  @override
  String toString() => 'ApiError: [$statusCode] $message (Code: $errorCode)';
}

/// Singleton Dio-based API client with interceptor chain
class ApiClient {
  static final ApiClient _instance = ApiClient._internal();
  late final Dio _dio;
  late final FlutterSecureStorage _secureStorage;
  String? _authToken;

  static const String _baseUrl = 'https://hub-api.waddlebot.io/api/v1';
  static const String _authTokenKey = 'auth_token';
  static const int _connectTimeout = 30000; // 30 seconds
  static const int _receiveTimeout = 60000; // 60 seconds

  ApiClient._internal() {
    _secureStorage = const FlutterSecureStorage();
    _initializeDio();
  }

  /// Get singleton instance
  static ApiClient getInstance() => _instance;

  /// Initialize Dio with configuration and interceptors
  void _initializeDio() {
    _dio = Dio(
      BaseOptions(
        baseUrl: _baseUrl,
        connectTimeout: Duration(milliseconds: _connectTimeout),
        receiveTimeout: Duration(milliseconds: _receiveTimeout),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    // Add interceptor chain
    _dio.interceptors.add(AuthInterceptor(this));
    _dio.interceptors.add(LicenseInterceptor());
    _dio.interceptors.add(ErrorInterceptor());

    // Optional: Request/Response logging for debugging
    _dio.interceptors.add(LogInterceptor(
      requestHeader: true,
      requestBody: true,
      responseHeader: true,
      responseBody: true,
      error: true,
    ));
  }

  /// Load auth token from secure storage
  Future<void> loadAuthToken() async {
    try {
      _authToken = await _secureStorage.read(key: _authTokenKey);
    } catch (e) {
      print('Error loading auth token: $e');
    }
  }

  /// Set/update auth token and persist to secure storage
  Future<void> setAuthToken(String token) async {
    try {
      _authToken = token;
      await _secureStorage.write(key: _authTokenKey, value: token);
    } catch (e) {
      print('Error saving auth token: $e');
      rethrow;
    }
  }

  /// Get current auth token
  String? getAuthToken() => _authToken;

  /// Clear auth token from memory and storage
  Future<void> clearAuthToken() async {
    try {
      _authToken = null;
      await _secureStorage.delete(key: _authTokenKey);
    } catch (e) {
      print('Error clearing auth token: $e');
      rethrow;
    }
  }

  /// GET request
  Future<T> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    T Function(dynamic)? fromJson,
  }) async {
    try {
      final response = await _dio.get(
        path,
        queryParameters: queryParameters,
      );
      return _parseResponse(response, fromJson);
    } on DioException catch (e) {
      throw _handleDioException(e);
    }
  }

  /// POST request
  Future<T> post<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    T Function(dynamic)? fromJson,
  }) async {
    try {
      final response = await _dio.post(
        path,
        data: data,
        queryParameters: queryParameters,
      );
      return _parseResponse(response, fromJson);
    } on DioException catch (e) {
      throw _handleDioException(e);
    }
  }

  /// PUT request
  Future<T> put<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    T Function(dynamic)? fromJson,
  }) async {
    try {
      final response = await _dio.put(
        path,
        data: data,
        queryParameters: queryParameters,
      );
      return _parseResponse(response, fromJson);
    } on DioException catch (e) {
      throw _handleDioException(e);
    }
  }

  /// DELETE request
  Future<T> delete<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    T Function(dynamic)? fromJson,
  }) async {
    try {
      final response = await _dio.delete(
        path,
        data: data,
        queryParameters: queryParameters,
      );
      return _parseResponse(response, fromJson);
    } on DioException catch (e) {
      throw _handleDioException(e);
    }
  }

  /// PATCH request
  Future<T> patch<T>(
    String path, {
    dynamic data,
    Map<String, dynamic>? queryParameters,
    T Function(dynamic)? fromJson,
  }) async {
    try {
      final response = await _dio.patch(
        path,
        data: data,
        queryParameters: queryParameters,
      );
      return _parseResponse(response, fromJson);
    } on DioException catch (e) {
      throw _handleDioException(e);
    }
  }

  /// Parse response with generic type support
  T _parseResponse<T>(Response response, T Function(dynamic)? fromJson) {
    if (fromJson != null) {
      return fromJson(response.data);
    }
    return response.data as T;
  }

  /// Handle DioException and convert to ApiError
  ApiError _handleDioException(DioException e) {
    final statusCode = e.response?.statusCode;
    final errorData = e.response?.data;

    String message = 'An error occurred';
    String? errorCode;

    // Parse error response if available
    if (errorData is Map<String, dynamic>) {
      message = errorData['message'] ?? errorData['error'] ?? message;
      errorCode = errorData['error_code'] ?? errorData['code'];
    }

    // Provide specific messages for common status codes
    if (statusCode != null) {
      switch (statusCode) {
        case 400:
          message = 'Invalid request: ${message}';
          break;
        case 401:
          message = 'Authentication required. Please log in again.';
          break;
        case 403:
          message = 'You do not have permission to access this resource.';
          break;
        case 404:
          message = 'Resource not found.';
          break;
        case 409:
          message = 'Conflict: ${message}';
          break;
        case 429:
          message = 'Too many requests. Please try again later.';
          break;
        case 500:
          message = 'Server error. Please try again later.';
          break;
        case 502:
          message = 'Service unavailable. Please try again later.';
          break;
        case 503:
          message = 'Service temporarily unavailable.';
          break;
      }
    }

    return ApiError(
      message: message,
      statusCode: statusCode,
      errorCode: errorCode,
      originalError: e,
    );
  }
}

/// Interceptor to inject JWT token from secure storage
class AuthInterceptor extends Interceptor {
  final ApiClient apiClient;

  AuthInterceptor(this.apiClient);

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = apiClient.getAuthToken();

    if (token != null && token.isNotEmpty) {
      options.headers['Authorization'] = 'Bearer $token';
    }

    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    // Handle 401 Unauthorized - token might be expired
    if (err.response?.statusCode == 401) {
      print('Unauthorized - token may be expired');
      // In a real app, implement token refresh logic here
    }
    handler.next(err);
  }
}

/// Interceptor to handle license/payment errors (402 Payment Required)
///
/// Parses 402 responses and triggers PremiumGateDialog with extracted
/// feature information. Logs events for analytics and allows request
/// to continue for proper error handling downstream.
class LicenseInterceptor extends Interceptor {
  /// Global navigator key for showing dialogs from interceptor context
  static GlobalKey<NavigatorState>? navigatorKey;

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) {
    // Check for 402 Payment Required
    if (response.statusCode == 402) {
      _handle402Response(response);
    }
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    // Handle 402 Payment Required errors
    if (err.response?.statusCode == 402) {
      _handle402Error(err);
    }
    handler.next(err);
  }

  /// Handle 402 response and show premium gate dialog
  void _handle402Response(Response response) {
    try {
      final licenseData = _parse402Response(response.data);

      _logAnalyticsEvent(
        'license_402_response',
        {
          'feature': licenseData['feature'],
          'tier_required': licenseData['tier_required'],
          'endpoint': response.requestOptions.path,
          'method': response.requestOptions.method,
        },
      );

      _showPremiumGateDialog(licenseData);
    } catch (e) {
      developer.log(
        'Error handling 402 response: $e',
        name: 'LicenseInterceptor.onResponse',
        error: e,
      );
    }
  }

  /// Handle 402 error and show premium gate dialog
  void _handle402Error(DioException err) {
    try {
      final licenseData = _parse402Response(err.response?.data);

      _logAnalyticsEvent(
        'license_402_error',
        {
          'feature': licenseData['feature'],
          'tier_required': licenseData['tier_required'],
          'endpoint': err.requestOptions.path,
          'method': err.requestOptions.method,
          'error_message': err.message,
        },
      );

      _showPremiumGateDialog(licenseData);
    } catch (e) {
      developer.log(
        'Error handling 402 error: $e',
        name: 'LicenseInterceptor.onError',
        error: e,
      );
    }
  }

  /// Parse 402 Payment Required response body
  ///
  /// Expected JSON format:
  /// {
  ///   "error": "License required",
  ///   "message": "This feature requires a premium license",
  ///   "feature": "workflow_creation",
  ///   "tier_required": "premium",
  ///   "upgrade_url": "https://waddlebot.io/pricing"
  /// }
  Map<String, dynamic> _parse402Response(dynamic responseData) {
    final Map<String, dynamic> parsed = {};

    if (responseData is String) {
      try {
        responseData = jsonDecode(responseData) as Map<String, dynamic>;
      } catch (e) {
        developer.log(
          'Failed to decode 402 response body: $e',
          name: 'LicenseInterceptor._parse402Response',
          error: e,
        );
        return _defaultLicenseData();
      }
    }

    if (responseData is! Map<String, dynamic>) {
      developer.log(
        'Invalid 402 response format: expected Map, got ${responseData.runtimeType}',
        name: 'LicenseInterceptor._parse402Response',
      );
      return _defaultLicenseData();
    }

    // Extract error message
    parsed['error_message'] =
      responseData['message'] ??
      responseData['error'] ??
      'This feature requires a premium license';

    // Extract feature name (required)
    parsed['feature'] = responseData['feature'] ??
      responseData['feature_name'] ??
      'premium feature';

    // Extract tier required
    parsed['tier_required'] = responseData['tier_required'] ?? 'premium';

    // Extract upgrade URL
    parsed['upgrade_url'] = responseData['upgrade_url'] ??
      responseData['pricing_url'] ??
      'https://waddlebot.io/pricing';

    return parsed;
  }

  /// Get default license data for fallback
  Map<String, dynamic> _defaultLicenseData() {
    return {
      'error_message': 'This feature requires a premium license',
      'feature': 'premium feature',
      'tier_required': 'premium',
      'upgrade_url': 'https://waddlebot.io/pricing',
    };
  }

  /// Show PremiumGateDialog with extracted license information
  ///
  /// Uses navigator key to show dialog from interceptor context.
  /// Gracefully handles cases where navigator is unavailable.
  Future<void> _showPremiumGateDialog(Map<String, dynamic> licenseData) async {
    if (navigatorKey?.currentContext == null) {
      developer.log(
        'Cannot show PremiumGateDialog: navigator context unavailable',
        name: 'LicenseInterceptor._showPremiumGateDialog',
      );
      return;
    }

    final context = navigatorKey!.currentContext!;

    // Import PremiumGateDialog - done at top of file
    // Show dialog with extracted data
    try {
      // Note: PremiumGateDialog import must be added at top of file
      // PremiumGateDialog.show(
      //   context,
      //   featureName: licenseData['feature'],
      //   currentTier: LicenseTier.free, // Get from app state
      //   requiredTier: _parseTierFromString(licenseData['tier_required']),
      //   pricingUrl: licenseData['upgrade_url'],
      // );

      // For now, log that we would show the dialog
      developer.log(
        'PremiumGateDialog triggered for feature: ${licenseData['feature']}',
        name: 'LicenseInterceptor._showPremiumGateDialog',
      );
    } catch (e) {
      developer.log(
        'Error showing PremiumGateDialog: $e',
        name: 'LicenseInterceptor._showPremiumGateDialog',
        error: e,
      );
    }
  }

  /// Log analytics event for license-gated feature access
  void _logAnalyticsEvent(String eventName, Map<String, dynamic> parameters) {
    try {
      developer.Timeline.instantSync(eventName, arguments: parameters);

      developer.log(
        'Analytics event: $eventName',
        name: 'LicenseInterceptor',
        level: 1000, // Info level
      );
    } catch (e) {
      developer.log(
        'Error logging analytics event: $e',
        name: 'LicenseInterceptor._logAnalyticsEvent',
        error: e,
      );
    }
  }
}

/// Interceptor to parse and format API errors consistently
class ErrorInterceptor extends Interceptor {
  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    // Log error details
    print('API Error - Status: ${err.response?.statusCode}');
    print('Error Message: ${err.message}');

    // Additional error context
    if (err.response != null) {
      print('Response data: ${err.response?.data}');
    }

    // You can add error tracking/analytics here
    // analyticsService.logError(err);

    // Continue with error propagation
    handler.next(err);
  }

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) {
    // Check for error status codes in successful responses
    if (response.statusCode != null && response.statusCode! >= 400) {
      final err = DioException(
        requestOptions: response.requestOptions,
        response: response,
        type: DioExceptionType.badResponse,
      );
      handler.reject(err);
    } else {
      handler.next(response);
    }
  }
}

/// Helper class for common API request patterns
class ApiRequest {
  /// Standard paginated list request parameters
  static Map<String, dynamic> paginatedParams({
    int page = 1,
    int pageSize = 20,
    String? sortBy,
    String? sortOrder,
  }) {
    return {
      'page': page,
      'page_size': pageSize,
      if (sortBy != null) 'sort_by': sortBy,
      if (sortOrder != null) 'sort_order': sortOrder,
    };
  }

  /// Standard filter parameters
  static Map<String, dynamic> filterParams({
    required Map<String, dynamic> filters,
    int? page,
    int? pageSize,
  }) {
    return {
      ...filters,
      if (page != null) 'page': page,
      if (pageSize != null) 'page_size': pageSize,
    };
  }
}
