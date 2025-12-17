"""
Music providers module.

This module provides abstract base classes and interfaces for integrating
with various music streaming services.
"""

from .base_provider import BaseMusicProvider, MusicTrack
from .spotify_provider import SpotifyProvider, SpotifyAuthError, SpotifyAPIError
from .soundcloud_provider import SoundCloudProvider, SoundCloudAuthError, SoundCloudAPIError
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
    "SoundCloudProvider",
    "SoundCloudAuthError",
    "SoundCloudAPIError",
    "YouTubeProvider",
    "YouTubeProviderError",
    "YouTubeAuthenticationError",
    "YouTubeAPIError",
]
