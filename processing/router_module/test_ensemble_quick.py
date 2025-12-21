#!/usr/bin/env python3
"""
Quick test of ensemble language detector implementation.
Tests basic functionality without full pytest infrastructure.
"""

import asyncio
import sys
from services.translation_providers.ensemble_detector import EnsembleLanguageDetector


async def test_ensemble_detector():
    """Test the ensemble detector with various languages."""
    detector = EnsembleLanguageDetector()

    test_cases = [
        ('Hello, how are you?', 'en'),
        ('¿Hola, cómo estás?', 'es'),
        ('Bonjour, comment allez-vous?', 'fr'),
        ('Guten Tag, wie geht es Ihnen?', 'de'),
        ('Ciao, come stai?', 'it'),
        ('Olá, como vai?', 'pt'),
        ('Привет, как дела?', 'ru'),
        ('こんにちは、お元気ですか？', 'ja'),
        ('你好，今天怎么样？', 'zh'),
        ('안녕하세요, 어떻게 지내세요?', 'ko'),
    ]

    print("\n" + "="*60)
    print("Ensemble Language Detector - Quick Test")
    print("="*60 + "\n")

    passed = 0
    failed = 0

    for text, expected_lang in test_cases:
        try:
            lang, confidence = await detector.detect_language(text)

            # Mark as pass if detected language matches expected
            is_match = lang == expected_lang
            status = '✓ PASS' if is_match else '✗ FAIL'

            if is_match:
                passed += 1
            else:
                failed += 1

            print(f"{status}: {text[:40]:40} -> {lang} ({confidence:.0%})")

        except Exception as e:
            failed += 1
            print(f"✗ FAIL: {text[:40]:40} -> ERROR: {e}")

    print("\n" + "="*60)
    print(f"Results: {passed} passed, {failed} failed")
    print("="*60 + "\n")

    return failed == 0


if __name__ == '__main__':
    try:
        success = asyncio.run(test_ensemble_detector())
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)
