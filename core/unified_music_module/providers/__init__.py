"""
Music providers module.

This module provides abstract base classes and interfaces for integrating
with various music streaming services.
"""

from .base_provider import BaseMusicProvider, MusicTrack
from .spotify_provider import SpotifyProvider, SpotifyAuthError, SpotifyAPIError
from .youtube_provider import (
    YouTubeProvider,
    YouTubeProviderError,
    YouTubeAuthenticationError,
    YouTubeAPIError,
)

__all__ = [
    "BaseMusicProvider",
    "MusicTrack",
    "SpotifyProvider",
    "SpotifyAuthError",
    "SpotifyAPIError",
    "YouTubeProvider",
    "YouTubeProviderError",
    "YouTubeAuthenticationError",
    "YouTubeAPIError",
]
