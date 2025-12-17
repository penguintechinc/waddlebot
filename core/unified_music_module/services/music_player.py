"""
Music Player Service - Queue-based playback orchestration

Orchestrates music playback across multiple providers (Spotify, YouTube, SoundCloud)
using a unified queue. Manages playback state per community and sends now-playing
updates to the browser source overlay.

Features:
- Initialize with providers dictionary
- Play, pause, skip, and get_now_playing operations
- Process queue from UnifiedQueue
- Track current playback state per community
- Send now-playing updates to browser source via HTTP POST
- Automatic provider switching based on track provider
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None

from providers.base_provider import BaseMusicProvider, MusicTrack
from services.unified_queue import UnifiedQueue, QueueStatus, QueueItem

logger = logging.getLogger(__name__)


@dataclass
class PlaybackState:
    """Track playback state for a community.

    Attributes:
        community_id: ID of the community
        current_queue_item: Currently playing QueueItem
        is_playing: Whether playback is active
        is_paused: Whether playback is paused
        current_provider: Name of the active provider
        started_at: ISO timestamp when playback started
        last_updated: ISO timestamp of last state update
    """

    community_id: int
    current_queue_item: Optional[QueueItem] = None
    is_playing: bool = False
    is_paused: bool = False
    current_provider: Optional[str] = None
    started_at: Optional[str] = None
    last_updated: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "community_id": self.community_id,
            "current_queue_item": self.current_queue_item.to_dict() if self.current_queue_item else None,
            "is_playing": self.is_playing,
            "is_paused": self.is_paused,
            "current_provider": self.current_provider,
            "started_at": self.started_at,
            "last_updated": self.last_updated,
        }


class MusicPlayer:
    """
    Music player orchestrator for queue-based playback.

    Manages playback across multiple music providers using a unified queue system.
    Tracks playback state per community and sends updates to browser source overlay.
    """

    def __init__(
        self,
        providers: Dict[str, BaseMusicProvider],
        queue: UnifiedQueue,
        browser_source_url: Optional[str] = None,
        http_timeout: float = 10.0,
    ):
        """
        Initialize the music player.

        Args:
            providers: Dictionary mapping provider names to provider instances
                      (e.g., {"spotify": spotify_provider, "youtube": youtube_provider})
            queue: UnifiedQueue instance for queue management
            browser_source_url: URL to browser source API for sending updates
                              (defaults to BROWSER_SOURCE_URL env var)
            http_timeout: Timeout for HTTP requests in seconds
        """
        if not providers:
            raise ValueError("At least one provider must be provided")

        self.providers = providers
        self.queue = queue
        self.browser_source_url = browser_source_url or os.getenv(
            "BROWSER_SOURCE_URL", "http://browser-source:8050"
        )
        self.http_timeout = http_timeout

        # Track playback state per community
        self._playback_states: Dict[int, PlaybackState] = {}

        # HTTP client for sending updates
        self._http_client: Optional[httpx.AsyncClient] = None

        logger.info(
            f"Initialized MusicPlayer with providers: {list(providers.keys())} "
            f"(browser_source_url={self.browser_source_url})"
        )

    async def initialize(self):
        """Initialize HTTP client and validate providers (call during startup)"""
        if HTTPX_AVAILABLE:
            self._http_client = httpx.AsyncClient(timeout=self.http_timeout)
            logger.info("HTTP client initialized for browser source updates")
        else:
            logger.warning(
                "httpx not available, browser source updates will be skipped"
            )

    async def shutdown(self):
        """Shutdown HTTP client and cleanup (call during shutdown)"""
        if self._http_client:
            await self._http_client.aclose()
            logger.info("HTTP client closed")

    async def play(self, community_id: int) -> bool:
        """
        Start playing the next track from the queue.

        Retrieves the next queued track, selects appropriate provider,
        and sends now-playing update to browser source.

        Args:
            community_id: ID of community to play music for

        Returns:
            True if playback started successfully, False otherwise
        """
        try:
            # Get next track from queue
            next_track_item = await self.queue.get_next_track(community_id)

            if not next_track_item:
                logger.warning(f"No tracks in queue for community {community_id}")
                return False

            # Mark as playing in queue
            await self.queue.mark_playing(next_track_item.id, community_id)

            # Get provider for this track
            provider_name = next_track_item.track.provider
            provider = self.providers.get(provider_name)

            if not provider:
                logger.error(
                    f"No provider configured for '{provider_name}' "
                    f"(available: {list(self.providers.keys())})"
                )
                # Mark as skipped since we can't play it
                await self.queue.mark_played(next_track_item.id, community_id)
                return False

            # Start playback with provider
            play_result = await provider.play(next_track_item.track.track_id)

            if not play_result:
                logger.error(
                    f"Provider '{provider_name}' failed to play track "
                    f"'{next_track_item.track.name}' ({next_track_item.track.track_id})"
                )
                # Mark as skipped since we can't play it
                await self.queue.mark_played(next_track_item.id, community_id)
                return False

            # Update playback state
            playback_state = PlaybackState(
                community_id=community_id,
                current_queue_item=next_track_item,
                is_playing=True,
                is_paused=False,
                current_provider=provider_name,
                started_at=datetime.utcnow().isoformat(),
                last_updated=datetime.utcnow().isoformat(),
            )
            self._playback_states[community_id] = playback_state

            logger.info(
                f"Started playing '{next_track_item.track.name}' "
                f"by {next_track_item.track.artist} "
                f"(provider: {provider_name}, community: {community_id})"
            )

            # Send now-playing update to browser source
            asyncio.create_task(
                self._send_now_playing_update(community_id, next_track_item.track)
            )

            return True

        except Exception as e:
            logger.error(f"Error in play(): {e}", exc_info=True)
            return False

    async def pause(self, community_id: int) -> bool:
        """
        Pause the currently playing track.

        Args:
            community_id: ID of community to pause playback for

        Returns:
            True if pause was successful, False otherwise
        """
        try:
            playback_state = self._playback_states.get(community_id)

            if not playback_state or not playback_state.is_playing:
                logger.warning(
                    f"No active playback to pause for community {community_id}"
                )
                return False

            # Pause with current provider
            provider = self.providers.get(playback_state.current_provider)
            if not provider:
                logger.error(
                    f"Provider '{playback_state.current_provider}' not found"
                )
                return False

            pause_result = await provider.pause()

            if pause_result:
                playback_state.is_paused = True
                playback_state.is_playing = False
                playback_state.last_updated = datetime.utcnow().isoformat()

                logger.info(f"Paused playback for community {community_id}")
                return True
            else:
                logger.error(
                    f"Provider '{playback_state.current_provider}' failed to pause"
                )
                return False

        except Exception as e:
            logger.error(f"Error in pause(): {e}", exc_info=True)
            return False

    async def resume(self, community_id: int) -> bool:
        """
        Resume playback of the paused track.

        Args:
            community_id: ID of community to resume playback for

        Returns:
            True if resume was successful, False otherwise
        """
        try:
            playback_state = self._playback_states.get(community_id)

            if not playback_state or playback_state.is_playing:
                logger.warning(
                    f"No paused playback to resume for community {community_id}"
                )
                return False

            # Resume with current provider
            provider = self.providers.get(playback_state.current_provider)
            if not provider:
                logger.error(
                    f"Provider '{playback_state.current_provider}' not found"
                )
                return False

            resume_result = await provider.resume()

            if resume_result:
                playback_state.is_paused = False
                playback_state.is_playing = True
                playback_state.last_updated = datetime.utcnow().isoformat()

                logger.info(f"Resumed playback for community {community_id}")
                return True
            else:
                logger.error(
                    f"Provider '{playback_state.current_provider}' failed to resume"
                )
                return False

        except Exception as e:
            logger.error(f"Error in resume(): {e}", exc_info=True)
            return False

    async def skip(self, community_id: int) -> Optional[MusicTrack]:
        """
        Skip to the next track in the queue.

        Marks current track as skipped in queue, skips via provider,
        and automatically starts playing the next track.

        Args:
            community_id: ID of community to skip for

        Returns:
            MusicTrack of next track if available, None if queue is empty
        """
        try:
            playback_state = self._playback_states.get(community_id)

            # Skip with current provider if something is playing
            if playback_state and playback_state.current_provider:
                provider = self.providers.get(playback_state.current_provider)
                if provider:
                    await provider.skip()

            # Skip current track in queue
            next_track_item = await self.queue.skip_current(community_id)

            if not next_track_item:
                logger.info(f"Queue empty after skip for community {community_id}")
                # Clear playback state
                if community_id in self._playback_states:
                    del self._playback_states[community_id]
                # Send empty now-playing update
                asyncio.create_task(
                    self._send_now_playing_update(community_id, None)
                )
                return None

            # Auto-play next track
            play_result = await self.play(community_id)

            if play_result:
                logger.info(
                    f"Skipped to next track for community {community_id}: "
                    f"'{next_track_item.track.name}'"
                )
                return next_track_item.track
            else:
                logger.warning(
                    f"Failed to auto-play next track after skip for community {community_id}"
                )
                return None

        except Exception as e:
            logger.error(f"Error in skip(): {e}", exc_info=True)
            return None

    async def get_now_playing(self, community_id: int) -> Optional[Dict[str, Any]]:
        """
        Get information about the currently playing track.

        Args:
            community_id: ID of community

        Returns:
            Dictionary with now-playing information, or None if nothing is playing
        """
        try:
            playback_state = self._playback_states.get(community_id)

            if not playback_state or not playback_state.current_queue_item:
                return None

            track = playback_state.current_queue_item.track
            queue_item = playback_state.current_queue_item

            return {
                "track": {
                    "track_id": track.track_id,
                    "name": track.name,
                    "artist": track.artist,
                    "album": track.album,
                    "album_art_url": track.album_art_url,
                    "duration_ms": track.duration_ms,
                    "provider": track.provider,
                    "uri": track.uri,
                },
                "queue_item": {
                    "id": queue_item.id,
                    "requested_by_user_id": queue_item.requested_by_user_id,
                    "requested_at": queue_item.requested_at,
                    "votes": queue_item.votes,
                },
                "playback_state": {
                    "is_playing": playback_state.is_playing,
                    "is_paused": playback_state.is_paused,
                    "provider": playback_state.current_provider,
                    "started_at": playback_state.started_at,
                },
            }

        except Exception as e:
            logger.error(f"Error in get_now_playing(): {e}", exc_info=True)
            return None

    async def get_playback_state(self, community_id: int) -> Optional[PlaybackState]:
        """
        Get raw playback state for a community.

        Args:
            community_id: ID of community

        Returns:
            PlaybackState object or None if no state exists
        """
        return self._playback_states.get(community_id)

    async def stop_playback(self, community_id: int) -> bool:
        """
        Stop playback for a community.

        Args:
            community_id: ID of community

        Returns:
            True if stopped successfully
        """
        try:
            playback_state = self._playback_states.get(community_id)

            if not playback_state:
                return False

            # Pause with current provider
            if playback_state.current_provider:
                provider = self.providers.get(playback_state.current_provider)
                if provider:
                    await provider.pause()

            # Clear playback state
            del self._playback_states[community_id]

            # Send empty now-playing update
            asyncio.create_task(self._send_now_playing_update(community_id, None))

            logger.info(f"Stopped playback for community {community_id}")
            return True

        except Exception as e:
            logger.error(f"Error in stop_playback(): {e}", exc_info=True)
            return False

    async def _send_now_playing_update(
        self,
        community_id: int,
        track: Optional[MusicTrack] = None,
    ) -> bool:
        """
        Send now-playing update to browser source overlay via HTTP POST.

        Args:
            community_id: ID of community
            track: MusicTrack currently playing, or None if nothing playing

        Returns:
            True if update was sent successfully, False otherwise
        """
        try:
            if not HTTPX_AVAILABLE or not self._http_client:
                return False

            if not self.browser_source_url:
                return False

            # Build payload
            payload = {
                "community_id": community_id,
                "type": "now_playing",
                "timestamp": datetime.utcnow().isoformat(),
            }

            if track:
                payload["track"] = {
                    "name": track.name,
                    "artist": track.artist,
                    "album": track.album,
                    "album_art_url": track.album_art_url,
                    "duration_ms": track.duration_ms,
                    "provider": track.provider,
                }
            else:
                payload["track"] = None

            # Send to browser source
            endpoint = f"{self.browser_source_url}/api/v1/internal/now-playing"

            response = await self._http_client.post(
                endpoint,
                json=payload,
                timeout=self.http_timeout,
            )

            if response.status_code == 200:
                logger.debug(
                    f"Sent now-playing update to browser source for community {community_id}"
                )
                return True
            else:
                logger.warning(
                    f"Browser source returned {response.status_code} "
                    f"for now-playing update: {response.text}"
                )
                return False

        except Exception as e:
            logger.warning(
                f"Failed to send now-playing update to browser source: {e}"
            )
            return False

    def get_all_playback_states(self) -> Dict[int, PlaybackState]:
        """
        Get playback states for all communities.

        Returns:
            Dictionary mapping community_id to PlaybackState
        """
        return self._playback_states.copy()

    async def check_provider_health(self) -> Dict[str, bool]:
        """
        Check health status of all configured providers.

        Returns:
            Dictionary mapping provider names to health status
        """
        health_status = {}

        for provider_name, provider in self.providers.items():
            try:
                is_healthy = await provider.health_check()
                health_status[provider_name] = is_healthy
            except Exception as e:
                logger.warning(
                    f"Health check failed for provider '{provider_name}': {e}"
                )
                health_status[provider_name] = False

        return health_status
