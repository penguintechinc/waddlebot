"""
Base music provider abstract class.

This module defines the abstract base class and data models for all music providers.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import asyncio


@dataclass
class MusicTrack:
    """Represents a music track with metadata.

    Attributes:
        track_id: Unique identifier for the track within the provider.
        name: The title/name of the track.
        artist: The artist or performer of the track.
        album: The album name containing the track.
        album_art_url: URL to the album artwork image.
        duration_ms: Duration of the track in milliseconds.
        provider: The music provider name (e.g., 'spotify', 'youtube_music').
        uri: The provider-specific URI or URL for the track.
        metadata: Additional provider-specific metadata.
    """

    track_id: str
    name: str
    artist: str
    album: str
    album_art_url: str
    duration_ms: int
    provider: str
    uri: str
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseMusicProvider(ABC):
    """Abstract base class for music providers.

    All music provider implementations must inherit from this class and
    implement all abstract methods. This ensures a consistent interface
    across different music services.
    """

    PROVIDER_NAME: str = NotImplemented
    """The name of the music provider (e.g., 'spotify', 'youtube_music')."""

    @abstractmethod
    async def search(self, query: str, limit: int = 10) -> list[MusicTrack]:
        """Search for tracks matching the query.

        Args:
            query: The search query string.
            limit: Maximum number of results to return. Defaults to 10.

        Returns:
            A list of MusicTrack objects matching the search query.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def get_track(self, track_id: str) -> Optional[MusicTrack]:
        """Get track information by track ID.

        Args:
            track_id: The unique track identifier within the provider.

        Returns:
            A MusicTrack object if found, None otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def play(self, track_id: str) -> bool:
        """Start playing a track.

        Args:
            track_id: The unique track identifier within the provider.

        Returns:
            True if playback started successfully, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def pause(self) -> bool:
        """Pause the currently playing track.

        Returns:
            True if pause was successful, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def resume(self) -> bool:
        """Resume playback of the currently paused track.

        Returns:
            True if resume was successful, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def skip(self) -> bool:
        """Skip to the next track in the queue.

        Returns:
            True if skip was successful, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def get_now_playing(self) -> Optional[MusicTrack]:
        """Get information about the currently playing track.

        Returns:
            A MusicTrack object for the current track, or None if nothing is playing.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def is_authenticated(self) -> bool:
        """Check if the provider is authenticated.

        Returns:
            True if authenticated, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def authenticate(self, credentials: Dict[str, Any]) -> bool:
        """Authenticate with the music provider.

        Args:
            credentials: A dictionary containing authentication credentials.
                         The exact structure depends on the provider.

        Returns:
            True if authentication was successful, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass

    @abstractmethod
    async def health_check(self) -> bool:
        """Check if the provider service is healthy and accessible.

        Returns:
            True if the service is healthy, False otherwise.

        Raises:
            NotImplementedError: If the method is not implemented by subclass.
        """
        pass
