"""
Unit tests for SoundCloud music provider implementation.

This test module demonstrates usage of the SoundCloudProvider and verifies
all major functionality.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timedelta

from .soundcloud_provider import (
    SoundCloudProvider,
    SoundCloudAuthError,
    SoundCloudAPIError,
)
from .base_provider import MusicTrack


class TestSoundCloudProviderAuthentication:
    """Tests for SoundCloud authentication functionality."""

    def test_provider_initialization(self):
        """Test that provider initializes with required environment variables."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            assert provider.client_id == "test_client_id"
            assert provider.client_secret == "test_client_secret"
            assert provider.redirect_uri == "http://localhost:8000/callback"
            assert provider.PROVIDER_NAME == "soundcloud"

    def test_provider_init_missing_env_vars(self):
        """Test that provider raises error when environment variables are missing."""
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError) as exc_info:
                SoundCloudProvider()
            assert "Missing required environment variables" in str(exc_info.value)

    def test_get_auth_url(self):
        """Test OAuth2 authorization URL generation."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            auth_url = provider.get_auth_url(state="test_state")

            assert "https://soundcloud.com/oauth/authorize" in auth_url
            assert "client_id=test_client_id" in auth_url
            assert "response_type=code" in auth_url
            assert "state=test_state" in auth_url

    @pytest.mark.asyncio
    async def test_authenticate_with_access_token(self):
        """Test authentication with provided access token."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            credentials = {
                "access_token": "test_token_123",
                "expires_in": 3600,
            }

            result = await provider.authenticate(credentials)
            assert result is True
            assert provider.access_token == "test_token_123"
            assert provider.token_expires_at is not None

    @pytest.mark.asyncio
    async def test_is_authenticated(self):
        """Test authentication status checking."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            # Not authenticated initially
            assert await provider.is_authenticated() is False

            # Authenticate
            credentials = {"access_token": "test_token_123"}
            await provider.authenticate(credentials)

            # Now authenticated
            assert await provider.is_authenticated() is True


class TestSoundCloudProviderURLParsing:
    """Tests for SoundCloud URL parsing."""

    def test_parse_soundcloud_url(self):
        """Test parsing of SoundCloud web URL."""
        url = "https://soundcloud.com/artistname/track-title"
        result = SoundCloudProvider.parse_track_url(url)
        assert result == url.split('?')[0]

    def test_parse_soundcloud_url_with_params(self):
        """Test parsing of SoundCloud URL with query parameters."""
        url = "https://soundcloud.com/artistname/track-title?utm_source=test"
        result = SoundCloudProvider.parse_track_url(url)
        assert result == "https://soundcloud.com/artistname/track-title"

    def test_parse_soundcloud_uri(self):
        """Test parsing of SoundCloud URI scheme."""
        uri = "soundcloud://users:123/sounds:456"
        result = SoundCloudProvider.parse_track_url(uri)
        assert result == uri

    def test_parse_invalid_url(self):
        """Test parsing of invalid URL returns None."""
        result = SoundCloudProvider.parse_track_url("https://example.com/track")
        assert result is None


class TestSoundCloudProviderTrackConversion:
    """Tests for SoundCloud track data conversion."""

    def test_convert_track(self):
        """Test conversion of SoundCloud track data to MusicTrack."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            track_data = {
                "id": 123456,
                "title": "Test Track",
                "duration": 240000,
                "artwork_url": "https://example.com/image-large.jpg",
                "uri": "soundcloud://tracks:123456",
                "stream_url": "https://example.com/stream/123456",
                "playback_count": 1000,
                "likes_count": 50,
                "description": "Test description",
                "genre": "Electronic",
                "downloadable": True,
                "user": {
                    "id": 789,
                    "username": "testartist",
                },
            }

            track = provider._convert_track(track_data)

            assert isinstance(track, MusicTrack)
            assert track.track_id == "123456"
            assert track.name == "Test Track"
            assert track.artist == "testartist"
            assert track.duration_ms == 240000
            assert track.provider == "soundcloud"
            assert track.metadata["playback_count"] == 1000
            assert track.metadata["likes_count"] == 50
            assert track.metadata["genre"] == "Electronic"


class TestSoundCloudProviderPlayback:
    """Tests for SoundCloud playback control."""

    @pytest.mark.asyncio
    async def test_pause_when_playing(self):
        """Test pausing playback."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            provider.is_playing = True

            result = await provider.pause()
            assert result is True
            assert provider.is_playing is False

    @pytest.mark.asyncio
    async def test_pause_when_not_playing(self):
        """Test pausing when nothing is playing."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            provider.is_playing = False

            result = await provider.pause()
            assert result is False

    @pytest.mark.asyncio
    async def test_resume_playback(self):
        """Test resuming paused playback."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            # Create a mock track
            track = MusicTrack(
                track_id="123",
                name="Test Track",
                artist="Test Artist",
                album="Test Album",
                album_art_url="https://example.com/art.jpg",
                duration_ms=240000,
                provider="soundcloud",
                uri="soundcloud://tracks:123",
            )

            provider.current_queue = [track]
            provider.is_playing = False

            result = await provider.resume()
            assert result is True
            assert provider.is_playing is True

    @pytest.mark.asyncio
    async def test_skip_to_next_track(self):
        """Test skipping to next track in queue."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            # Create mock tracks
            track1 = MusicTrack(
                track_id="123", name="Track 1", artist="Artist",
                album="Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:123"
            )
            track2 = MusicTrack(
                track_id="124", name="Track 2", artist="Artist",
                album="Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:124"
            )

            provider.current_queue = [track1, track2]
            provider.current_track_index = 0

            result = await provider.skip()
            assert result is True
            assert provider.current_track_index == 1

    @pytest.mark.asyncio
    async def test_get_now_playing(self):
        """Test getting currently playing track."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            track = MusicTrack(
                track_id="123", name="Track 1", artist="Artist",
                album="Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:123"
            )

            provider.current_queue = [track]
            provider.is_playing = True
            provider.current_track_index = 0

            now_playing = await provider.get_now_playing()
            assert now_playing == track

    @pytest.mark.asyncio
    async def test_get_now_playing_when_stopped(self):
        """Test getting now playing when nothing is playing."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            provider.is_playing = False

            now_playing = await provider.get_now_playing()
            assert now_playing is None


class TestSoundCloudProviderQueue:
    """Tests for SoundCloud queue functionality."""

    @pytest.mark.asyncio
    async def test_add_to_queue(self):
        """Test adding a track to queue."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()
            provider.access_token = "test_token"

            # Mock the get_track method
            track = MusicTrack(
                track_id="123", name="Test Track", artist="Test Artist",
                album="Test Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:123"
            )

            with patch.object(provider, "get_track", return_value=track):
                result = await provider.add_to_queue("123")
                assert result is True
                assert len(provider.current_queue) == 1
                assert provider.current_queue[0].track_id == "123"

    @pytest.mark.asyncio
    async def test_get_queue(self):
        """Test getting the current queue."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            track = MusicTrack(
                track_id="123", name="Test Track", artist="Test Artist",
                album="Test Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:123"
            )

            provider.current_queue = [track]
            queue = await provider.get_queue()

            assert len(queue) == 1
            assert queue[0].track_id == "123"

    @pytest.mark.asyncio
    async def test_clear_queue(self):
        """Test clearing the playback queue."""
        with patch.dict("os.environ", {
            "SOUNDCLOUD_CLIENT_ID": "test_client_id",
            "SOUNDCLOUD_CLIENT_SECRET": "test_client_secret",
            "SOUNDCLOUD_REDIRECT_URI": "http://localhost:8000/callback",
        }):
            provider = SoundCloudProvider()

            track = MusicTrack(
                track_id="123", name="Test Track", artist="Test Artist",
                album="Test Album", album_art_url="", duration_ms=240000,
                provider="soundcloud", uri="soundcloud://tracks:123"
            )

            provider.current_queue = [track]
            provider.is_playing = True

            result = await provider.clear_queue()
            assert result is True
            assert len(provider.current_queue) == 0
            assert provider.is_playing is False


if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v"])
