#!/usr/bin/env python3
"""
Test script comparing Ensemble Detection vs Qwen2.5:1.5b AI Detection

This script runs the same test messages through both:
1. Ensemble detector (FastText + Lingua + langdetect)
2. Qwen2.5:1.5b via Ollama (direct API call)

Purpose: Verify that AI verification would help, not hurt, accuracy.
Note: Qwen2.5:1.5b achieves 93%+ accuracy vs TinyLlama's 0% accuracy.
"""
import asyncio
import httpx
import time

# Test messages with known languages
TEST_MESSAGES = [
    # High confidence cases - ensemble should nail these
    ("Hello, how are you doing today? This is a test message.", "en", "English - clear"),
    ("Hola amigo, me encanta tu contenido y tu stream!", "es", "Spanish - clear"),
    ("Bonjour! J'adore ton stream, c'est vraiment magnifique!", "fr", "French - clear"),
    ("Ich schaue deine Streams seit zwei Jahren!", "de", "German - clear"),

    # Medium confidence cases - where AI might help
    ("Hey geweldige stream", "nl", "Dutch - short"),
    ("Ciao sei fantastico", "it", "Italian - short"),
    ("Oi seu stream é legal", "pt", "Portuguese - short"),

    # Tricky cases - mixed signals
    ("Gracias amigo KEKW", "es", "Spanish with emote"),
    ("Merci beaucoup mon ami", "fr", "French - formal"),
    ("Das ist sehr gut ja", "de", "German - casual"),

    # CJK languages
    ("素晴らしいストリームですね!毎日見ています!", "ja", "Japanese"),
    ("정말 재미있어요! 계속 방송해주세요!", "ko", "Korean"),
    ("你的直播太棒了,我每天都看!", "zh", "Chinese"),

    # Other scripts
    ("отличный стрим! спасибо за контент!", "ru", "Russian"),
    ("بث رائع! أحب محتواك كثيرا!", "ar", "Arabic"),
]

OLLAMA_URL = "http://ollama:11434"


async def detect_with_ollama(text: str, timeout: float = 30.0) -> tuple:
    """
    Detect language using Qwen2.5:1.5b via Ollama API.

    Returns:
        Tuple of (language_code, confidence, response_time_ms)
    """
    prompt = f"""You are a language detection expert. Detect the language of the following text.
Return ONLY the ISO 639-1 language code (e.g., 'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'ru', 'ar') and your confidence (0.0-1.0).
Format: LANG_CODE:CONFIDENCE
Example: es:0.95

Text to analyze: "{text}"

Response (format LANG_CODE:CONFIDENCE only):"""

    try:
        start_time = time.time()

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": "qwen2.5:1.5b",  # Multilingual model (100+ languages)
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.1,  # Low temperature for consistent results
                        "num_predict": 20,   # Short response
                    }
                },
                timeout=timeout
            )

            elapsed_ms = (time.time() - start_time) * 1000

            if response.status_code == 200:
                data = response.json()
                result = data.get("response", "").strip()

                # Parse response (format: LANG_CODE:CONFIDENCE)
                if ":" in result:
                    parts = result.split(":")
                    lang_code = parts[0].strip().lower()[:2]  # Take first 2 chars
                    try:
                        confidence = float(parts[1].strip()[:4])  # Take first few chars
                        confidence = min(1.0, max(0.0, confidence))
                    except (ValueError, IndexError):
                        confidence = 0.7
                    return lang_code, confidence, elapsed_ms
                else:
                    # Try to extract just the language code
                    lang_code = result.strip().lower()[:2]
                    return lang_code, 0.7, elapsed_ms
            else:
                return "error", 0.0, elapsed_ms

    except Exception as e:
        return f"error:{str(e)[:20]}", 0.0, 0.0


async def detect_with_ensemble(text: str) -> tuple:
    """
    Detect language using the ensemble detector.

    Returns:
        Tuple of (language_code, confidence, response_time_ms)
    """
    from services.translation_providers.ensemble_detector import EnsembleLanguageDetector

    detector = EnsembleLanguageDetector()

    try:
        start_time = time.time()
        lang_code, confidence = await detector.detect_language(text)
        elapsed_ms = (time.time() - start_time) * 1000
        return lang_code, confidence, elapsed_ms
    except Exception as e:
        return f"error:{str(e)[:20]}", 0.0, 0.0


async def run_comparison():
    """Run comparison between ensemble and AI detection."""
    print("=" * 90)
    print("ENSEMBLE vs QWEN2.5:1.5B LANGUAGE DETECTION COMPARISON")
    print("=" * 90)
    print()

    # Test Ollama connectivity
    print("Testing Ollama connectivity...")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{OLLAMA_URL}/api/tags", timeout=5.0)
            if response.status_code == 200:
                models = response.json().get("models", [])
                model_names = [m.get("name", "") for m in models]
                print(f"  ✓ Ollama connected. Models: {model_names}")
            else:
                print(f"  ✗ Ollama returned status {response.status_code}")
                return
    except Exception as e:
        print(f"  ✗ Cannot connect to Ollama: {e}")
        print("  Make sure Ollama is running and qwen2.5:1.5b is pulled.")
        return

    print()
    print("=" * 90)
    print(f"{'Description':<25} | {'Expected':<8} | {'Ensemble':<12} | {'Qwen2.5':<12} | {'Winner':<10}")
    print("-" * 90)

    ensemble_correct = 0
    ai_correct = 0
    ensemble_total_time = 0
    ai_total_time = 0

    for text, expected, description in TEST_MESSAGES:
        # Run both detections
        ensemble_lang, ensemble_conf, ensemble_time = await detect_with_ensemble(text)
        ai_lang, ai_conf, ai_time = await detect_with_ollama(text)

        ensemble_total_time += ensemble_time
        ai_total_time += ai_time

        # Check correctness
        ensemble_match = ensemble_lang == expected
        ai_match = ai_lang == expected

        if ensemble_match:
            ensemble_correct += 1
        if ai_match:
            ai_correct += 1

        # Determine winner
        if ensemble_match and ai_match:
            winner = "TIE"
        elif ensemble_match:
            winner = "ENSEMBLE"
        elif ai_match:
            winner = "AI"
        else:
            winner = "NEITHER"

        # Format results
        ensemble_result = f"{ensemble_lang} ({ensemble_conf:.0%})"
        ai_result = f"{ai_lang} ({ai_conf:.0%})" if not ai_lang.startswith("error") else ai_lang[:12]

        ensemble_mark = "✓" if ensemble_match else "✗"
        ai_mark = "✓" if ai_match else "✗"

        print(f"{description:<25} | {expected:<8} | {ensemble_mark} {ensemble_result:<10} | {ai_mark} {ai_result:<10} | {winner:<10}")

    # Summary
    print("=" * 90)
    print()
    print("SUMMARY")
    print("-" * 40)
    total = len(TEST_MESSAGES)
    print(f"Ensemble Accuracy: {ensemble_correct}/{total} ({ensemble_correct/total*100:.1f}%)")
    print(f"Qwen2.5:1.5b Accuracy: {ai_correct}/{total} ({ai_correct/total*100:.1f}%)")
    print()
    print(f"Ensemble Total Time: {ensemble_total_time:.0f}ms ({ensemble_total_time/total:.0f}ms avg)")
    print(f"Qwen2.5:1.5b Total Time: {ai_total_time:.0f}ms ({ai_total_time/total:.0f}ms avg)")
    print()

    # Recommendation
    if ensemble_correct > ai_correct:
        print("📊 RECOMMENDATION: Ensemble is more accurate. AI verification should only be used")
        print("   for uncertain cases (70-90% confidence) to avoid hurting accuracy.")
    elif ai_correct > ensemble_correct:
        print("📊 RECOMMENDATION: Qwen2.5:1.5b is more accurate! Consider using AI more often.")
    else:
        print("📊 RECOMMENDATION: Both are equally accurate. Use ensemble for speed,")
        print("   AI verification only for uncertain cases.")

    print()
    print("=" * 90)


if __name__ == "__main__":
    asyncio.run(run_comparison())
