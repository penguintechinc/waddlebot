import 'package:flutter/material.dart';
import 'package:flutter_libs/flutter_libs.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'app.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Get package info for version display
  final packageInfo = await PackageInfo.fromPlatform();

  // Log app version to console for debugging
  debugPrint('Flutter Gazer v${packageInfo.version}+${packageInfo.buildNumber}');

  runApp(const GazerApp());
}
