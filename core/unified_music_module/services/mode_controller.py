"""
Mode Controller Service - Manages switching between Music Player and Radio Player modes

Orchestrates mode switching between the Music Player (queue-based playback) and Radio Player
(single stream playback) services. Ensures only one mode is active per community at any time.

Features:
- Singleton mode controller per service instance
- One active mode per community (music, radio, or None)
- Coordinated mode switching with proper cleanup
- Mode change notifications to browser source overlay
- Track mode history and transitions
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional, Dict, Any, Tuple

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None

logger = logging.getLogger(__name__)


class PlayMode(str, Enum):
    """Active playback mode for a community"""
    MUSIC = "music"
    RADIO = "radio"
    NONE = "none"


@dataclass
class ModeState:
    """Track mode state for a community.

    Attributes:
        community_id: ID of the community
        active_mode: Currently active mode (music, radio, or None)
        previous_mode: Previously active mode
        music_paused_on_switch: Whether music was paused when switching to radio
        radio_paused_on_switch: Whether radio was paused when switching to music
        switched_at: ISO timestamp when mode was switched
        last_updated: ISO timestamp of last state update
    """

    community_id: int
    active_mode: PlayMode = PlayMode.NONE
    previous_mode: Optional[PlayMode] = None
    music_paused_on_switch: bool = False
    radio_paused_on_switch: bool = False
    switched_at: Optional[str] = None
    last_updated: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "community_id": self.community_id,
            "active_mode": self.active_mode.value if self.active_mode else None,
            "previous_mode": self.previous_mode.value if self.previous_mode else None,
            "music_paused_on_switch": self.music_paused_on_switch,
            "radio_paused_on_switch": self.radio_paused_on_switch,
            "switched_at": self.switched_at,
            "last_updated": self.last_updated,
        }


class ModeController:
    """
    Coordinates switching between Music Player and Radio Player modes.

    Manages mode state per community, enforces mutual exclusivity of modes,
    handles cleanup and state preservation during mode transitions, and sends
    notifications to browser source overlay.
    """

    def __init__(
        self,
        music_player=None,
        radio_player=None,
        browser_source_url: Optional[str] = None,
        http_timeout: float = 10.0,
    ):
        """
        Initialize the mode controller.

        Args:
            music_player: MusicPlayer service instance
            radio_player: RadioPlayer service instance
            browser_source_url: URL to browser source API for sending updates
                              (defaults to BROWSER_SOURCE_URL env var)
            http_timeout: Timeout for HTTP requests in seconds
        """
        if not music_player and not radio_player:
            raise ValueError("At least one player service must be provided")

        self.music_player = music_player
        self.radio_player = radio_player
        self.browser_source_url = browser_source_url or os.getenv(
            "BROWSER_SOURCE_URL", "http://browser-source:8050"
        )
        self.http_timeout = http_timeout

        # Track mode state per community
        self._mode_states: Dict[int, ModeState] = {}

        # HTTP client for sending updates
        self._http_client: Optional[httpx.AsyncClient] = None

        # Lock for thread-safe mode transitions per community
        self._transition_locks: Dict[int, asyncio.Lock] = {}

        logger.info(
            f"Initialized ModeController with music_player={bool(music_player)}, "
            f"radio_player={bool(radio_player)} "
            f"(browser_source_url={self.browser_source_url})"
        )

    async def initialize(self):
        """Initialize HTTP client and validate players (call during startup)"""
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

    async def switch_to_music(self, community_id: int) -> bool:
        """
        Switch to Music Player mode for a community.

        If radio is currently playing, stops it and saves state for potential resume.
        If music was paused, resumes playback; otherwise starts playing next queued track.

        Args:
            community_id: ID of community to switch music mode for

        Returns:
            True if switched successfully to music mode, False otherwise
        """
        try:
            # Get or create transition lock for this community
            if community_id not in self._transition_locks:
                self._transition_locks[community_id] = asyncio.Lock()

            async with self._transition_locks[community_id]:
                # Get current mode state
                mode_state = self._get_or_create_mode_state(community_id)

                # If already in music mode, nothing to do
                if mode_state.active_mode == PlayMode.MUSIC:
                    logger.debug(f"Community {community_id} already in music mode")
                    return True

                logger.info(
                    f"Switching community {community_id} from {mode_state.active_mode.value} to music mode"
                )

                # Stop radio if playing
                if mode_state.active_mode == PlayMode.RADIO and self.radio_player:
                    try:
                        radio_state = await self.radio_player.get_current_station(community_id)
                        if radio_state:
                            mode_state.radio_paused_on_switch = True
                            await self.radio_player.stop_station(community_id)
                            logger.info(
                                f"Stopped radio for community {community_id}"
                            )
                    except Exception as e:
                        logger.error(f"Error stopping radio: {e}")
                        return False

                # Update mode state
                mode_state.previous_mode = mode_state.active_mode
                mode_state.active_mode = PlayMode.MUSIC
                mode_state.switched_at = datetime.utcnow().isoformat()
                mode_state.last_updated = datetime.utcnow().isoformat()

                # Send notification to browser source
                asyncio.create_task(
                    self._send_mode_change_notification(
                        community_id, PlayMode.MUSIC, mode_state.previous_mode
                    )
                )

                logger.info(
                    f"Successfully switched community {community_id} to music mode"
                )
                return True

        except Exception as e:
            logger.error(f"Error switching to music mode: {e}", exc_info=True)
            return False

    async def switch_to_radio(self, community_id: int) -> bool:
        """
        Switch to Radio Player mode for a community.

        If music is currently playing, pauses it and saves state for potential resume.
        Requires a radio station to be pre-configured.

        Args:
            community_id: ID of community to switch radio mode for

        Returns:
            True if switched successfully to radio mode, False otherwise
        """
        try:
            # Get or create transition lock for this community
            if community_id not in self._transition_locks:
                self._transition_locks[community_id] = asyncio.Lock()

            async with self._transition_locks[community_id]:
                # Get current mode state
                mode_state = self._get_or_create_mode_state(community_id)

                # If already in radio mode, nothing to do
                if mode_state.active_mode == PlayMode.RADIO:
                    logger.debug(f"Community {community_id} already in radio mode")
                    return True

                logger.info(
                    f"Switching community {community_id} from {mode_state.active_mode.value} to radio mode"
                )

                # Pause music if playing
                if mode_state.active_mode == PlayMode.MUSIC and self.music_player:
                    try:
                        playback_state = await self.music_player.get_playback_state(community_id)
                        if playback_state and playback_state.is_playing:
                            mode_state.music_paused_on_switch = True
                            await self.music_player.pause(community_id)
                            logger.info(
                                f"Paused music playback for community {community_id}"
                            )
                    except Exception as e:
                        logger.error(f"Error pausing music: {e}")
                        return False

                # Update mode state
                mode_state.previous_mode = mode_state.active_mode
                mode_state.active_mode = PlayMode.RADIO
                mode_state.switched_at = datetime.utcnow().isoformat()
                mode_state.last_updated = datetime.utcnow().isoformat()

                # Send notification to browser source
                asyncio.create_task(
                    self._send_mode_change_notification(
                        community_id, PlayMode.RADIO, mode_state.previous_mode
                    )
                )

                logger.info(
                    f"Successfully switched community {community_id} to radio mode"
                )
                return True

        except Exception as e:
            logger.error(f"Error switching to radio mode: {e}", exc_info=True)
            return False

    async def get_active_mode(self, community_id: int) -> Optional[str]:
        """
        Get the currently active playback mode for a community.

        Args:
            community_id: ID of community

        Returns:
            'music', 'radio', or None if no mode is active
        """
        try:
            mode_state = self._mode_states.get(community_id)

            if not mode_state or mode_state.active_mode == PlayMode.NONE:
                return None

            return mode_state.active_mode.value

        except Exception as e:
            logger.error(f"Error getting active mode: {e}")
            return None

    async def get_mode_state(self, community_id: int) -> Optional[ModeState]:
        """
        Get raw mode state for a community.

        Args:
            community_id: ID of community

        Returns:
            ModeState object or None if no state exists
        """
        return self._mode_states.get(community_id)

    async def resume_music_if_paused(self, community_id: int) -> bool:
        """
        Resume music playback if it was paused during mode switch.

        Call this after switching back to music mode to restore previous playback state.

        Args:
            community_id: ID of community

        Returns:
            True if music was resumed or was already playing, False if unable to resume
        """
        try:
            if not self.music_player:
                return False

            mode_state = self._mode_states.get(community_id)

            # If music was paused on switch, resume it
            if mode_state and mode_state.music_paused_on_switch:
                resume_result = await self.music_player.resume(community_id)
                if resume_result:
                    mode_state.music_paused_on_switch = False
                    logger.info(f"Resumed music for community {community_id}")
                    return True
                else:
                    logger.warning(f"Failed to resume music for community {community_id}")
                    return False

            # If not paused, nothing to resume
            return True

        except Exception as e:
            logger.error(f"Error resuming music: {e}", exc_info=True)
            return False

    async def stop_current_mode(self, community_id: int) -> bool:
        """
        Stop all playback for a community and clear mode state.

        Args:
            community_id: ID of community

        Returns:
            True if stopped successfully, False if nothing was playing
        """
        try:
            # Get or create transition lock for this community
            if community_id not in self._transition_locks:
                self._transition_locks[community_id] = asyncio.Lock()

            async with self._transition_locks[community_id]:
                mode_state = self._mode_states.get(community_id)

                if not mode_state or mode_state.active_mode == PlayMode.NONE:
                    return False

                logger.info(
                    f"Stopping {mode_state.active_mode.value} mode for community {community_id}"
                )

                # Stop current mode
                if mode_state.active_mode == PlayMode.MUSIC and self.music_player:
                    try:
                        await self.music_player.stop_playback(community_id)
                    except Exception as e:
                        logger.error(f"Error stopping music: {e}")

                elif mode_state.active_mode == PlayMode.RADIO and self.radio_player:
                    try:
                        await self.radio_player.stop_station(community_id)
                    except Exception as e:
                        logger.error(f"Error stopping radio: {e}")

                # Update mode state
                mode_state.previous_mode = mode_state.active_mode
                mode_state.active_mode = PlayMode.NONE
                mode_state.music_paused_on_switch = False
                mode_state.radio_paused_on_switch = False
                mode_state.last_updated = datetime.utcnow().isoformat()

                # Send notification to browser source
                asyncio.create_task(
                    self._send_mode_change_notification(
                        community_id, PlayMode.NONE, mode_state.previous_mode
                    )
                )

                logger.info(
                    f"Stopped playback for community {community_id}"
                )
                return True

        except Exception as e:
            logger.error(f"Error stopping current mode: {e}", exc_info=True)
            return False

    async def get_all_mode_states(self) -> Dict[int, ModeState]:
        """
        Get mode states for all communities.

        Returns:
            Dictionary mapping community_id to ModeState
        """
        return {cid: state for cid, state in self._mode_states.items()}

    async def _send_mode_change_notification(
        self,
        community_id: int,
        new_mode: PlayMode,
        previous_mode: Optional[PlayMode] = None,
    ) -> bool:
        """
        Send mode change notification to browser source overlay via HTTP POST.

        Args:
            community_id: ID of community
            new_mode: New active mode
            previous_mode: Previous active mode

        Returns:
            True if notification was sent successfully, False otherwise
        """
        try:
            if not HTTPX_AVAILABLE or not self._http_client:
                return False

            if not self.browser_source_url:
                return False

            # Build payload
            payload = {
                "community_id": community_id,
                "type": "mode_change",
                "timestamp": datetime.utcnow().isoformat(),
                "new_mode": new_mode.value if new_mode else None,
                "previous_mode": previous_mode.value if previous_mode else None,
            }

            # Send to browser source
            endpoint = f"{self.browser_source_url}/api/v1/internal/mode-change"

            response = await self._http_client.post(
                endpoint,
                json=payload,
                timeout=self.http_timeout,
            )

            if response.status_code == 200:
                logger.debug(
                    f"Sent mode change notification to browser source for community {community_id}: "
                    f"{previous_mode.value if previous_mode else 'none'} -> {new_mode.value}"
                )
                return True
            else:
                logger.warning(
                    f"Browser source returned {response.status_code} "
                    f"for mode change notification: {response.text}"
                )
                return False

        except Exception as e:
            logger.warning(
                f"Failed to send mode change notification to browser source: {e}"
            )
            return False

    def _get_or_create_mode_state(self, community_id: int) -> ModeState:
        """
        Get existing mode state or create new one for community.

        Args:
            community_id: ID of community

        Returns:
            ModeState for the community
        """
        if community_id not in self._mode_states:
            self._mode_states[community_id] = ModeState(
                community_id=community_id,
                active_mode=PlayMode.NONE,
                last_updated=datetime.utcnow().isoformat(),
            )
        return self._mode_states[community_id]


def create_mode_controller(
    music_player=None,
    radio_player=None,
    browser_source_url: Optional[str] = None,
    http_timeout: float = 10.0,
) -> ModeController:
    """
    Factory function to create a ModeController instance.

    Args:
        music_player: MusicPlayer service instance
        radio_player: RadioPlayer service instance
        browser_source_url: URL to browser source API
        http_timeout: Timeout for HTTP requests in seconds

    Returns:
        Configured ModeController instance
    """
    return ModeController(
        music_player=music_player,
        radio_player=radio_player,
        browser_source_url=browser_source_url,
        http_timeout=http_timeout,
    )
