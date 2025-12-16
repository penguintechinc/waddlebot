"""
Translation Providers Package
=============================

Export all translation provider implementations and the base class.

Available Providers:
- TranslationProvider: Abstract base class
- GoogleTransProvider: Free Google Translate (primary)
- GoogleCloudProvider: Official Google Cloud API (premium)
- WaddleAIProvider: AI-powered fallback via WaddleAI proxy
"""

from .base_provider import TranslationProvider, TranslationResult
from .googletrans_provider import GoogleTransProvider
from .google_cloud_provider import GoogleCloudProvider
from .waddleai_provider import WaddleAIProvider

__all__ = [
    "TranslationProvider",
    "TranslationResult",
    "GoogleTransProvider",
    "GoogleCloudProvider",
    "WaddleAIProvider",
]
