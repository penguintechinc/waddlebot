import 'package:flutter/material.dart';
import 'package:flutter_libs/flutter_libs.dart';
import 'config/theme.dart';
import 'screens/main_screen.dart';

/// Root application widget for Gazer Mobile Stream Studio.
class GazerApp extends StatelessWidget {
  const GazerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Gazer Stream Studio',
      theme: GazerTheme.lightTheme,
      darkTheme: GazerTheme.darkTheme,
      themeMode: ThemeMode.dark,
      home: const MainScreen(),
      debugShowCheckedModeBanner: false,
    );
  }
}
