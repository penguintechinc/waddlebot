"""
Radio Player Service

Manages single-stream radio playback with support for multiple radio providers:
- Pretzel
- Epidemic Sound
- StreamBeats
- Monstercat
- Icecast-compatible streams

Features:
- Per-community active station management (only 1 active at a time)
- Station configuration storage in PostgreSQL (music_provider_config)
- Now-playing metadata fetching from streams
- Browser source overlay updates via WebSocket
- Station status and history tracking

Radio differs from MusicPlayer by having no queue - just stream switching.
All operations are async for high-performance streaming.
"""

import asyncio
import json
import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional, Dict, Any, List
from abc import ABC, abstractmethod

import httpx

logger = logging.getLogger(__name__)


class RadioStation(str, Enum):
    """Supported radio stations/providers"""
    PRETZEL = "pretzel"
    EPIDEMIC = "epidemic"
    STREAMBEATS = "streambeats"
    MONSTERCAT = "monstercat"
    ICECAST = "icecast"


@dataclass
class StationConfig:
    """Configuration for a radio station"""
    provider: str
    name: str
    stream_url: str
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    metadata_path: Optional[str] = None
    bitrate: Optional[int] = None
    codec: Optional[str] = None
    custom_headers: Dict[str, str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        data = asdict(self)
        if self.custom_headers is None:
            data['custom_headers'] = {}
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'StationConfig':
        """Create from dictionary"""
        if data.get('custom_headers') is None:
            data['custom_headers'] = {}
        return cls(**data)


@dataclass
class NowPlayingInfo:
    """Current now-playing metadata from stream"""
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    duration_seconds: Optional[int] = None
    bitrate: Optional[int] = None
    codec: Optional[str] = None
    genre: Optional[str] = None
    thumbnail_url: Optional[str] = None
    updated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'NowPlayingInfo':
        """Create from dictionary"""
        return cls(**{k: v for k, v in data.items() if k in cls.__annotations__})


class IcecastMetadataFetcher:
    """Fetches metadata from Icecast-compatible streams"""

    def __init__(self, stream_url: str, timeout: float = 5.0):
        """Initialize fetcher

        Args:
            stream_url: URL to the Icecast stream
            timeout: Request timeout in seconds
        """
        self.stream_url = stream_url
        self.timeout = timeout

    async def fetch_metadata(self) -> Optional[NowPlayingInfo]:
        """Fetch now-playing info from Icecast stream

        Icecast provides metadata via:
        1. ICY-MetaInt header (metadata interval)
        2. StreamTitle tag in metadata blocks

        Returns:
            NowPlayingInfo with parsed metadata, or None on failure
        """
        try:
            async with httpx.AsyncClient() as client:
                # Request with metadata
                headers = {"Icy-MetaData": "1"}
                async with client.stream(
                    "GET",
                    self.stream_url,
                    headers=headers,
                    timeout=self.timeout
                ) as response:
                    # Get metadata interval from headers
                    meta_int = response.headers.get("icy-metaint")
                    if not meta_int:
                        logger.debug("No Icecast metadata available")
                        return None

                    meta_int = int(meta_int)

                    # Read stream data to get metadata block
                    data = await response.aread()

                    # Extract metadata
                    if len(data) > meta_int:
                        # Get metadata block (size is first byte * 16)
                        meta_size = int(data[meta_int]) * 16
                        if meta_size > 0 and len(data) > meta_int + 1 + meta_size:
                            metadata_str = data[meta_int + 1:meta_int + 1 + meta_size].decode(
                                'utf-8', errors='ignore'
                            ).strip('\x00')

                            # Parse StreamTitle='artist - title'
                            if "StreamTitle=" in metadata_str:
                                stream_title = metadata_str.split("StreamTitle='")[1].split("';")[0]
                                parts = stream_title.split(" - ", 1)

                                return NowPlayingInfo(
                                    artist=parts[0].strip() if len(parts) > 0 else None,
                                    title=parts[1].strip() if len(parts) > 1 else stream_title,
                                    updated_at=datetime.utcnow().isoformat()
                                )

        except Exception as e:
            logger.warning(f"Failed to fetch Icecast metadata: {e}")

        return None


class MetadataProvider(ABC):
    """Abstract base for metadata providers"""

    @abstractmethod
    async def fetch_now_playing(self) -> Optional[NowPlayingInfo]:
        """Fetch current now-playing info

        Returns:
            NowPlayingInfo or None if unable to fetch
        """
        pass


class PretzelMetadataProvider(MetadataProvider):
    """Fetches metadata from Pretzel API"""

    def __init__(self, api_key: str, api_endpoint: str, timeout: float = 5.0):
        """Initialize Pretzel metadata provider

        Args:
            api_key: Pretzel API key
            api_endpoint: Pretzel API endpoint URL
            timeout: Request timeout
        """
        self.api_key = api_key
        self.api_endpoint = api_endpoint
        self.timeout = timeout

    async def fetch_now_playing(self) -> Optional[NowPlayingInfo]:
        """Fetch current track from Pretzel API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.api_endpoint}/current",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    return NowPlayingInfo(
                        title=data.get("track", {}).get("name"),
                        artist=data.get("track", {}).get("artist", {}).get("name"),
                        album=data.get("track", {}).get("album", {}).get("name"),
                        thumbnail_url=data.get("track", {}).get("album", {}).get("image_url"),
                        updated_at=datetime.utcnow().isoformat()
                    )

        except Exception as e:
            logger.warning(f"Failed to fetch Pretzel metadata: {e}")

        return None


class EpidemicMetadataProvider(MetadataProvider):
    """Fetches metadata from Epidemic Sound API"""

    def __init__(self, api_key: str, stream_id: str, timeout: float = 5.0):
        """Initialize Epidemic metadata provider

        Args:
            api_key: Epidemic Sound API key
            stream_id: Stream/station ID
            timeout: Request timeout
        """
        self.api_key = api_key
        self.stream_id = stream_id
        self.timeout = timeout

    async def fetch_now_playing(self) -> Optional[NowPlayingInfo]:
        """Fetch current track from Epidemic Sound API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"https://api.epidemicsound.com/v4/streams/{self.stream_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    track = data.get("current_track", {})
                    return NowPlayingInfo(
                        title=track.get("title"),
                        artist=track.get("artist", {}).get("name"),
                        album=track.get("album", {}).get("name"),
                        duration_seconds=track.get("duration"),
                        updated_at=datetime.utcnow().isoformat()
                    )

        except Exception as e:
            logger.warning(f"Failed to fetch Epidemic metadata: {e}")

        return None


class MonstercatMetadataProvider(MetadataProvider):
    """Fetches metadata from Monstercat API"""

    def __init__(self, api_key: str, timeout: float = 5.0):
        """Initialize Monstercat metadata provider

        Args:
            api_key: Monstercat API key
            timeout: Request timeout
        """
        self.api_key = api_key
        self.timeout = timeout

    async def fetch_now_playing(self) -> Optional[NowPlayingInfo]:
        """Fetch current track from Monstercat API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    "https://www.monstercat.com/api/now-playing",
                    headers={"X-API-Key": self.api_key},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    return NowPlayingInfo(
                        title=data.get("title"),
                        artist=data.get("artist"),
                        album=data.get("album"),
                        duration_seconds=data.get("duration"),
                        genre=data.get("genre"),
                        thumbnail_url=data.get("image_url"),
                        updated_at=datetime.utcnow().isoformat()
                    )

        except Exception as e:
            logger.warning(f"Failed to fetch Monstercat metadata: {e}")

        return None


class StreamBeatsMetadataProvider(MetadataProvider):
    """Fetches metadata from StreamBeats API"""

    def __init__(self, api_key: str, timeout: float = 5.0):
        """Initialize StreamBeats metadata provider

        Args:
            api_key: StreamBeats API key
            timeout: Request timeout
        """
        self.api_key = api_key
        self.timeout = timeout

    async def fetch_now_playing(self) -> Optional[NowPlayingInfo]:
        """Fetch current track from StreamBeats API"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    "https://api.streambeats.com/now-playing",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    return NowPlayingInfo(
                        title=data.get("track", {}).get("name"),
                        artist=data.get("track", {}).get("artist"),
                        album=data.get("track", {}).get("album"),
                        duration_seconds=data.get("track", {}).get("duration"),
                        thumbnail_url=data.get("track", {}).get("cover_art"),
                        updated_at=datetime.utcnow().isoformat()
                    )

        except Exception as e:
            logger.warning(f"Failed to fetch StreamBeats metadata: {e}")

        return None


class RadioPlayer:
    """
    Manages single-stream radio playback per community.

    Handles:
    - Station management (only 1 active per community)
    - Now-playing metadata fetching
    - Browser source overlay updates
    - Database persistence
    """

    def __init__(self, db_session=None, http_client: Optional[httpx.AsyncClient] = None):
        """Initialize radio player

        Args:
            db_session: Database session (PyDAL/SQLAlchemy compatible)
            http_client: Optional shared HTTP client for efficiency
        """
        self.db = db_session
        self.http_client = http_client
        self._active_stations: Dict[int, tuple[StationConfig, NowPlayingInfo]] = {}
        self._metadata_tasks: Dict[int, asyncio.Task] = {}
        self._metadata_cache: Dict[int, NowPlayingInfo] = {}
        self._cache_timestamp: Dict[int, datetime] = {}
        self._metadata_providers: Dict[str, MetadataProvider] = {}
        self._cache_ttl = 30  # 30 seconds metadata cache

    async def initialize(self):
        """Initialize radio player from database

        Loads active stations and starts metadata fetching tasks.
        Call this during startup.
        """
        try:
            logger.info("Initializing RadioPlayer")

            # Load active stations from database
            if self.db:
                # Query for active radio stations
                rows = await self._query_active_stations()

                for row in rows:
                    community_id = row.get('community_id')
                    station_name = row.get('current_station_name')

                    if community_id and station_name:
                        try:
                            await self.play_station(community_id, station_name)
                        except Exception as e:
                            logger.error(
                                f"Failed to restore station for community {community_id}: {e}"
                            )

            logger.info("RadioPlayer initialized successfully")

        except Exception as e:
            logger.error(f"Error during RadioPlayer initialization: {e}")

    async def shutdown(self):
        """Clean up resources and stop tasks

        Call this during graceful shutdown.
        """
        logger.info("Shutting down RadioPlayer")

        # Cancel all metadata fetching tasks
        for community_id, task in list(self._metadata_tasks.items()):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        self._metadata_tasks.clear()
        self._active_stations.clear()
        logger.info("RadioPlayer shutdown complete")

    async def play_station(self, community_id: int, station_name: str) -> bool:
        """Start playing a radio station

        Args:
            community_id: ID of community/channel
            station_name: Name of station to play (from StationConfig)

        Returns:
            True if playback started successfully, False otherwise
        """
        try:
            # Get station configuration
            config = await self.get_station_config(community_id, station_name)
            if not config:
                logger.error(f"Station config not found: {station_name}")
                return False

            # Stop current station if playing
            if community_id in self._metadata_tasks:
                await self.stop_station(community_id)

            # Validate stream URL is accessible
            if not await self._validate_stream(config.stream_url):
                logger.error(f"Stream validation failed for {station_name}")
                return False

            # Initialize metadata provider
            provider = await self._create_metadata_provider(config)

            # Update database
            if self.db:
                await self._update_radio_state(
                    community_id,
                    station_name,
                    config.stream_url,
                    'radio'
                )

            # Fetch initial metadata
            now_playing = None
            if provider:
                now_playing = await provider.fetch_now_playing()

            # Store active station
            self._active_stations[community_id] = (config, now_playing or NowPlayingInfo())
            self._metadata_providers[community_id] = provider

            # Start metadata refresh task
            self._metadata_tasks[community_id] = asyncio.create_task(
                self._refresh_metadata_loop(community_id, config, provider)
            )

            logger.info(
                f"Started playing {station_name} in community {community_id}"
            )

            return True

        except Exception as e:
            logger.error(f"Error starting station playback: {e}")
            return False

    async def stop_station(self, community_id: int) -> bool:
        """Stop playing current station

        Args:
            community_id: ID of community

        Returns:
            True if stopped successfully, False if no station was playing
        """
        try:
            if community_id not in self._active_stations:
                return False

            # Cancel metadata task
            if community_id in self._metadata_tasks:
                task = self._metadata_tasks[community_id]
                if task and not task.done():
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                del self._metadata_tasks[community_id]

            # Clear state
            del self._active_stations[community_id]
            self._metadata_cache.pop(community_id, None)
            self._cache_timestamp.pop(community_id, None)
            self._metadata_providers.pop(community_id, None)

            # Update database
            if self.db:
                await self._update_radio_state(community_id, None, None, 'music')

            logger.info(f"Stopped radio in community {community_id}")
            return True

        except Exception as e:
            logger.error(f"Error stopping station: {e}")
            return False

    async def get_current_station(self, community_id: int) -> Optional[Dict[str, Any]]:
        """Get current playing station info

        Args:
            community_id: ID of community

        Returns:
            Dictionary with station info and now-playing metadata, or None if not playing
        """
        if community_id not in self._active_stations:
            return None

        config, now_playing = self._active_stations[community_id]

        return {
            "station_name": config.name,
            "provider": config.provider,
            "stream_url": config.stream_url,
            "now_playing": now_playing.to_dict() if now_playing else None,
            "started_at": self._cache_timestamp.get(community_id, datetime.utcnow()).isoformat()
        }

    async def get_now_playing(self, community_id: int, use_cache: bool = True) -> Optional[NowPlayingInfo]:
        """Get current now-playing metadata

        Args:
            community_id: ID of community
            use_cache: Whether to use cached metadata (within TTL)

        Returns:
            NowPlayingInfo with current track details, or None if not available
        """
        if community_id not in self._active_stations:
            return None

        # Check cache first
        if use_cache and community_id in self._metadata_cache:
            timestamp = self._cache_timestamp.get(community_id)
            if timestamp and (datetime.utcnow() - timestamp).total_seconds() < self._cache_ttl:
                return self._metadata_cache[community_id]

        # Fetch fresh metadata
        if community_id in self._metadata_providers:
            provider = self._metadata_providers[community_id]
            if provider:
                now_playing = await provider.fetch_now_playing()
                if now_playing:
                    self._metadata_cache[community_id] = now_playing
                    self._cache_timestamp[community_id] = datetime.utcnow()
                    return now_playing

        # Return last known metadata
        if community_id in self._active_stations:
            return self._active_stations[community_id][1]

        return None

    async def get_station_config(
        self,
        community_id: int,
        station_name: str
    ) -> Optional[StationConfig]:
        """Get station configuration from database

        Args:
            community_id: ID of community
            station_name: Name of station

        Returns:
            StationConfig or None if not found
        """
        if not self.db:
            return None

        try:
            # Query music_provider_config for station
            row = await self._query_station_config(community_id, station_name)
            if not row:
                return None

            config_data = row.get('config', {})
            if isinstance(config_data, str):
                config_data = json.loads(config_data)

            return StationConfig(
                provider=row.get('provider_type'),
                name=station_name,
                stream_url=config_data.get('stream_url'),
                api_endpoint=config_data.get('api_endpoint'),
                api_key=config_data.get('api_key'),
                metadata_path=config_data.get('metadata_path'),
                bitrate=config_data.get('bitrate'),
                codec=config_data.get('codec'),
                custom_headers=config_data.get('custom_headers', {})
            )

        except Exception as e:
            logger.error(f"Error fetching station config: {e}")
            return None

    async def save_station_config(
        self,
        community_id: int,
        config: StationConfig
    ) -> bool:
        """Save station configuration to database

        Args:
            community_id: ID of community
            config: StationConfig to save

        Returns:
            True if saved successfully, False otherwise
        """
        if not self.db:
            return False

        try:
            # Prepare config data
            config_data = {
                'stream_url': config.stream_url,
                'api_endpoint': config.api_endpoint,
                'api_key': config.api_key,
                'metadata_path': config.metadata_path,
                'bitrate': config.bitrate,
                'codec': config.codec,
                'custom_headers': config.custom_headers or {}
            }

            # Upsert into music_provider_config
            await self._upsert_provider_config(
                community_id,
                config.provider,
                config_data
            )

            logger.info(f"Saved config for {config.name} in community {community_id}")
            return True

        except Exception as e:
            logger.error(f"Error saving station config: {e}")
            return False

    async def send_overlay_update(
        self,
        community_id: int,
        websocket_handler=None
    ) -> bool:
        """Send now-playing metadata to browser source overlay

        Args:
            community_id: ID of community
            websocket_handler: Async function to send WebSocket message

        Returns:
            True if sent successfully
        """
        try:
            now_playing = await self.get_now_playing(community_id)
            if not now_playing:
                return False

            current = await self.get_current_station(community_id)
            if not current:
                return False

            # Prepare overlay update message
            update_message = {
                "type": "radio_update",
                "community_id": community_id,
                "station": current['station_name'],
                "provider": current['provider'],
                "now_playing": now_playing.to_dict(),
                "timestamp": datetime.utcnow().isoformat()
            }

            # Send via WebSocket handler if provided
            if websocket_handler:
                await websocket_handler(community_id, update_message)
                return True

            return True

        except Exception as e:
            logger.error(f"Error sending overlay update: {e}")
            return False

    async def get_active_stations(self) -> Dict[int, Dict[str, Any]]:
        """Get all active stations across communities

        Returns:
            Dictionary mapping community_id to station info
        """
        active = {}
        for community_id in list(self._active_stations.keys()):
            station = await self.get_current_station(community_id)
            if station:
                active[community_id] = station

        return active

    # Private helper methods

    async def _validate_stream(self, stream_url: str) -> bool:
        """Validate that a stream URL is accessible

        Args:
            stream_url: URL to validate

        Returns:
            True if stream is accessible
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.head(
                    stream_url,
                    timeout=5.0,
                    follow_redirects=True
                )
                return response.status_code < 400

        except Exception as e:
            logger.warning(f"Stream validation failed for {stream_url}: {e}")
            return False

    async def _create_metadata_provider(self, config: StationConfig) -> Optional[MetadataProvider]:
        """Create appropriate metadata provider for station

        Args:
            config: Station configuration

        Returns:
            MetadataProvider instance or None
        """
        try:
            if config.provider == RadioStation.ICECAST.value:
                return IcecastMetadataFetcher(config.stream_url)

            elif config.provider == RadioStation.PRETZEL.value:
                if config.api_key and config.api_endpoint:
                    return PretzelMetadataProvider(config.api_key, config.api_endpoint)

            elif config.provider == RadioStation.EPIDEMIC.value:
                if config.api_key:
                    stream_id = config.metadata_path or "default"
                    return EpidemicMetadataProvider(config.api_key, stream_id)

            elif config.provider == RadioStation.MONSTERCAT.value:
                if config.api_key:
                    return MonstercatMetadataProvider(config.api_key)

            elif config.provider == RadioStation.STREAMBEATS.value:
                if config.api_key:
                    return StreamBeatsMetadataProvider(config.api_key)

        except Exception as e:
            logger.warning(f"Error creating metadata provider: {e}")

        return None

    async def _refresh_metadata_loop(
        self,
        community_id: int,
        config: StationConfig,
        provider: Optional[MetadataProvider]
    ):
        """Background task to periodically refresh metadata

        Args:
            community_id: ID of community
            config: Station configuration
            provider: Metadata provider instance
        """
        while True:
            try:
                await asyncio.sleep(self._cache_ttl)

                if provider and community_id in self._active_stations:
                    now_playing = await provider.fetch_now_playing()
                    if now_playing:
                        self._metadata_cache[community_id] = now_playing
                        self._cache_timestamp[community_id] = datetime.utcnow()

                        # Update stored station info
                        cfg, _ = self._active_stations[community_id]
                        self._active_stations[community_id] = (cfg, now_playing)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in metadata refresh loop: {e}")

    # Database operations (async wrappers)

    async def _query_active_stations(self) -> List[Dict[str, Any]]:
        """Query active radio stations from database"""
        try:
            # This assumes PyDAL-style database access
            # Adapt based on actual database interface
            if hasattr(self.db, 'executesql'):
                result = self.db.executesql("""
                    SELECT community_id, current_station_name, current_station_url
                    FROM music_radio_state
                    WHERE mode = 'radio' AND current_station_name IS NOT NULL
                """)
                return [dict(row) for row in result]
            else:
                # Fallback for other database interfaces
                return []
        except Exception as e:
            logger.error(f"Error querying active stations: {e}")
            return []

    async def _query_station_config(
        self,
        community_id: int,
        station_name: str
    ) -> Optional[Dict[str, Any]]:
        """Query station config from database"""
        try:
            if hasattr(self.db, 'executesql'):
                result = self.db.executesql("""
                    SELECT provider_type, config
                    FROM music_provider_config
                    WHERE community_id = %s
                        AND is_enabled = TRUE
                        AND config->>'name' = %s
                    LIMIT 1
                """, [community_id, station_name])

                if result:
                    row = result[0]
                    return {
                        'provider_type': row[0],
                        'config': json.loads(row[1]) if isinstance(row[1], str) else row[1]
                    }
        except Exception as e:
            logger.error(f"Error querying station config: {e}")

        return None

    async def _update_radio_state(
        self,
        community_id: int,
        station_name: Optional[str],
        stream_url: Optional[str],
        mode: str = 'radio'
    ) -> bool:
        """Update music_radio_state in database"""
        try:
            if hasattr(self.db, 'executesql'):
                self.db.executesql("""
                    INSERT INTO music_radio_state
                    (community_id, mode, current_station_name, current_station_url, updated_at)
                    VALUES (%s, %s, %s, %s, NOW())
                    ON CONFLICT (community_id) DO UPDATE SET
                        mode = EXCLUDED.mode,
                        current_station_name = EXCLUDED.current_station_name,
                        current_station_url = EXCLUDED.current_station_url,
                        updated_at = NOW()
                """, [community_id, mode, station_name, stream_url])

                return True
        except Exception as e:
            logger.error(f"Error updating radio state: {e}")

        return False

    async def _upsert_provider_config(
        self,
        community_id: int,
        provider_type: str,
        config_data: Dict[str, Any]
    ) -> bool:
        """Upsert music provider configuration"""
        try:
            if hasattr(self.db, 'executesql'):
                self.db.executesql("""
                    INSERT INTO music_provider_config
                    (community_id, provider_type, config, is_enabled, updated_at)
                    VALUES (%s, %s, %s, TRUE, NOW())
                    ON CONFLICT (community_id, provider_type) DO UPDATE SET
                        config = EXCLUDED.config,
                        is_enabled = TRUE,
                        updated_at = NOW()
                """, [community_id, provider_type, json.dumps(config_data)])

                return True
        except Exception as e:
            logger.error(f"Error upserting provider config: {e}")

        return False


# Factory function
def create_radio_player(db_session=None, http_client: Optional[httpx.AsyncClient] = None) -> RadioPlayer:
    """Factory function to create a RadioPlayer instance

    Args:
        db_session: Database session
        http_client: Optional shared HTTP client

    Returns:
        Configured RadioPlayer instance
    """
    return RadioPlayer(db_session=db_session, http_client=http_client)
