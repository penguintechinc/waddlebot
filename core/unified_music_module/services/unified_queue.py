"""
Unified Music Queue Service

Manages a cross-provider music queue with voting, prioritization, and
Redis-backed persistence. Supports tracks from Spotify, YouTube, SoundCloud,
and other music providers in a single unified queue.

Features:
- Cross-provider track queuing
- Vote-based track prioritization
- Redis persistence with TTL
- Per-community queue isolation
- Track status lifecycle management
- Automatic position management
"""

import json
import logging
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional, List, Dict, Any
from enum import Enum

try:
    import redis.asyncio as redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False
    redis = None

from providers.base_provider import MusicTrack

logger = logging.getLogger(__name__)


class QueueStatus(str, Enum):
    """Status of a queue item"""
    QUEUED = "queued"
    PLAYING = "playing"
    PLAYED = "played"
    SKIPPED = "skipped"


@dataclass
class QueueItem:
    """Represents a track in the queue.

    Attributes:
        id: Unique identifier for this queue entry
        track: The MusicTrack object
        requested_by_user_id: ID of user who requested the track
        requested_at: ISO timestamp when track was requested
        votes: Number of votes (can be negative)
        position: Position in queue (0-indexed)
        status: Current status (queued, playing, played, skipped)
        community_id: ID of community this queue item belongs to
    """
    id: str
    track: MusicTrack
    requested_by_user_id: str
    requested_at: str
    votes: int
    position: int
    status: QueueStatus
    community_id: int
    voters: List[str] = field(default_factory=list)  # Track who voted

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        data = asdict(self)
        # Convert MusicTrack to dict
        data['track'] = asdict(self.track)
        # Convert enum to string
        data['status'] = self.status.value
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'QueueItem':
        """Create QueueItem from dictionary"""
        # Reconstruct MusicTrack
        track_data = data['track']
        track = MusicTrack(**track_data)

        # Convert status string to enum
        status = QueueStatus(data['status'])

        return cls(
            id=data['id'],
            track=track,
            requested_by_user_id=data['requested_by_user_id'],
            requested_at=data['requested_at'],
            votes=data['votes'],
            position=data['position'],
            status=status,
            community_id=data['community_id'],
            voters=data.get('voters', [])
        )


class UnifiedQueue:
    """
    Unified music queue manager with Redis backend.

    Manages music queues across multiple providers with voting,
    prioritization, and persistence.
    """

    def __init__(
        self,
        redis_url: Optional[str] = None,
        namespace: str = "music_queue",
        queue_ttl: int = 86400,  # 24 hours default
        enable_fallback: bool = True
    ):
        """
        Initialize unified queue manager.

        Args:
            redis_url: Redis connection URL (redis://host:port/db)
            namespace: Key namespace for queue data
            queue_ttl: TTL for queue items in seconds (default 24 hours)
            enable_fallback: Use in-memory fallback if Redis unavailable
        """
        self.redis_url = redis_url
        self.namespace = namespace
        self.queue_ttl = queue_ttl
        self.enable_fallback = enable_fallback

        self._redis: Optional[redis.Redis] = None
        self._fallback_queues: Dict[int, List[QueueItem]] = {}
        self._fallback_enabled = False
        self._connected = False

    async def connect(self):
        """Connect to Redis (call during startup)"""
        if not REDIS_AVAILABLE:
            logger.warning(
                "redis package not available, using in-memory fallback queue"
            )
            self._fallback_enabled = True
            return

        if not self.redis_url:
            logger.warning(
                "No Redis URL provided, using in-memory fallback queue"
            )
            self._fallback_enabled = True
            return

        try:
            self._redis = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5
            )

            # Test connection
            await self._redis.ping()
            self._connected = True
            logger.info(f"Connected to Redis for music queue: {self.namespace}")

        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            if self.enable_fallback:
                logger.info("Falling back to in-memory queue")
                self._fallback_enabled = True
            else:
                raise

    async def disconnect(self):
        """Disconnect from Redis (call during shutdown)"""
        if self._redis:
            await self._redis.close()
            self._connected = False
            logger.info("Disconnected from Redis music queue")

    def _make_key(self, community_id: int, suffix: str = "queue") -> str:
        """Create namespaced Redis key"""
        return f"{self.namespace}:{community_id}:{suffix}"

    async def add_track(
        self,
        track: MusicTrack,
        user_id: str,
        community_id: int
    ) -> QueueItem:
        """
        Add a track to the queue.

        Args:
            track: MusicTrack object to add
            user_id: ID of user requesting the track
            community_id: ID of community/channel

        Returns:
            Created QueueItem
        """
        # Get current queue to determine position
        current_queue = await self.get_queue(community_id)

        # Find next position for queued items
        queued_items = [item for item in current_queue if item.status == QueueStatus.QUEUED]
        next_position = len(queued_items)

        # Create queue item
        queue_item = QueueItem(
            id=str(uuid.uuid4()),
            track=track,
            requested_by_user_id=user_id,
            requested_at=datetime.utcnow().isoformat(),
            votes=0,
            position=next_position,
            status=QueueStatus.QUEUED,
            community_id=community_id,
            voters=[]
        )

        # Store in Redis or fallback
        await self._save_queue_item(queue_item)

        logger.info(
            f"Added track '{track.name}' by {track.artist} to queue "
            f"for community {community_id} (provider: {track.provider})"
        )

        return queue_item

    async def remove_track(self, queue_id: str, community_id: int) -> bool:
        """
        Remove a track from the queue.

        Args:
            queue_id: ID of queue item to remove
            community_id: ID of community

        Returns:
            True if removed, False if not found
        """
        if self._fallback_enabled:
            # In-memory removal
            if community_id not in self._fallback_queues:
                return False

            queue = self._fallback_queues[community_id]
            original_len = len(queue)
            self._fallback_queues[community_id] = [
                item for item in queue if item.id != queue_id
            ]

            if len(self._fallback_queues[community_id]) < original_len:
                # Reposition remaining items
                await self._reposition_queue(community_id)
                return True
            return False

        if not self._connected:
            return False

        try:
            # Remove from Redis list
            key = self._make_key(community_id)

            # Get all items
            items = await self._get_all_items(community_id)

            # Filter out the item
            filtered_items = [item for item in items if item.id != queue_id]

            if len(filtered_items) == len(items):
                return False  # Item not found

            # Save filtered list
            await self._save_all_items(community_id, filtered_items)

            # Reposition remaining items
            await self._reposition_queue(community_id)

            logger.info(f"Removed queue item {queue_id} from community {community_id}")
            return True

        except Exception as e:
            logger.error(f"Error removing track: {e}")
            return False

    async def vote_track(
        self,
        queue_id: str,
        user_id: str,
        community_id: int,
        upvote: bool = True
    ) -> Optional[int]:
        """
        Vote on a track (upvote or downvote).

        Args:
            queue_id: ID of queue item
            user_id: ID of user voting
            community_id: ID of community
            upvote: True for upvote, False for downvote

        Returns:
            New vote count, or None if not found
        """
        items = await self._get_all_items(community_id)

        for item in items:
            if item.id == queue_id:
                # Check if user already voted
                if user_id in item.voters:
                    logger.warning(f"User {user_id} already voted on {queue_id}")
                    return item.votes

                # Add vote
                item.voters.append(user_id)
                item.votes += 1 if upvote else -1

                # Save updated items
                await self._save_all_items(community_id, items)

                logger.info(
                    f"User {user_id} {'upvoted' if upvote else 'downvoted'} "
                    f"queue item {queue_id} (new count: {item.votes})"
                )

                return item.votes

        return None

    async def get_queue(self, community_id: int) -> List[QueueItem]:
        """
        Get the current queue for a community.

        Args:
            community_id: ID of community

        Returns:
            List of QueueItem objects, sorted by position
        """
        items = await self._get_all_items(community_id)

        # Filter to only queued and playing items
        active_items = [
            item for item in items
            if item.status in [QueueStatus.QUEUED, QueueStatus.PLAYING]
        ]

        # Sort by position
        active_items.sort(key=lambda x: x.position)

        return active_items

    async def get_next_track(self, community_id: int) -> Optional[QueueItem]:
        """
        Get the next track to play.

        Args:
            community_id: ID of community

        Returns:
            Next QueueItem or None if queue is empty
        """
        queue = await self.get_queue(community_id)

        # Filter to only queued items
        queued_items = [item for item in queue if item.status == QueueStatus.QUEUED]

        if not queued_items:
            return None

        # Return first item (highest priority)
        return queued_items[0]

    async def mark_playing(self, queue_id: str, community_id: int) -> bool:
        """
        Mark a track as currently playing.

        Args:
            queue_id: ID of queue item
            community_id: ID of community

        Returns:
            True if updated, False if not found
        """
        return await self._update_status(queue_id, community_id, QueueStatus.PLAYING)

    async def mark_played(self, queue_id: str, community_id: int) -> bool:
        """
        Mark a track as played.

        Args:
            queue_id: ID of queue item
            community_id: ID of community

        Returns:
            True if updated, False if not found
        """
        return await self._update_status(queue_id, community_id, QueueStatus.PLAYED)

    async def skip_current(self, community_id: int) -> Optional[QueueItem]:
        """
        Skip the currently playing track.

        Args:
            community_id: ID of community

        Returns:
            The next track to play, or None if queue is empty
        """
        items = await self._get_all_items(community_id)

        # Find currently playing track
        for item in items:
            if item.status == QueueStatus.PLAYING:
                item.status = QueueStatus.SKIPPED
                logger.info(f"Skipped track {item.id} in community {community_id}")

        # Save updated items
        await self._save_all_items(community_id, items)

        # Return next track
        return await self.get_next_track(community_id)

    async def clear_queue(self, community_id: int) -> int:
        """
        Clear all queued tracks (not playing/played).

        Args:
            community_id: ID of community

        Returns:
            Number of tracks cleared
        """
        items = await self._get_all_items(community_id)

        # Filter to keep only non-queued items
        kept_items = [
            item for item in items
            if item.status != QueueStatus.QUEUED
        ]

        cleared_count = len(items) - len(kept_items)

        # Save filtered items
        await self._save_all_items(community_id, kept_items)

        logger.info(f"Cleared {cleared_count} tracks from community {community_id} queue")

        return cleared_count

    async def reorder_by_votes(self, community_id: int) -> None:
        """
        Reorder queued tracks by vote count (highest first).

        Args:
            community_id: ID of community
        """
        items = await self._get_all_items(community_id)

        # Separate queued from other items
        queued_items = [item for item in items if item.status == QueueStatus.QUEUED]
        other_items = [item for item in items if item.status != QueueStatus.QUEUED]

        # Sort queued items by votes (descending), then by requested_at (ascending)
        queued_items.sort(
            key=lambda x: (-x.votes, x.requested_at)
        )

        # Update positions
        for i, item in enumerate(queued_items):
            item.position = i

        # Combine and save
        all_items = queued_items + other_items
        await self._save_all_items(community_id, all_items)

        logger.info(f"Reordered {len(queued_items)} tracks by votes for community {community_id}")

    async def get_history(
        self,
        community_id: int,
        limit: int = 50
    ) -> List[QueueItem]:
        """
        Get play history for a community.

        Args:
            community_id: ID of community
            limit: Maximum number of items to return

        Returns:
            List of played/skipped tracks, most recent first
        """
        items = await self._get_all_items(community_id)

        # Filter to played/skipped items
        history_items = [
            item for item in items
            if item.status in [QueueStatus.PLAYED, QueueStatus.SKIPPED]
        ]

        # Sort by requested_at descending (most recent first)
        history_items.sort(key=lambda x: x.requested_at, reverse=True)

        return history_items[:limit]

    # Private helper methods

    async def _save_queue_item(self, item: QueueItem):
        """Save a single queue item"""
        items = await self._get_all_items(item.community_id)
        items.append(item)
        await self._save_all_items(item.community_id, items)

    async def _get_all_items(self, community_id: int) -> List[QueueItem]:
        """Get all queue items for a community"""
        if self._fallback_enabled:
            return self._fallback_queues.get(community_id, [])

        if not self._connected:
            return []

        try:
            key = self._make_key(community_id)
            data = await self._redis.get(key)

            if not data:
                return []

            items_data = json.loads(data)
            return [QueueItem.from_dict(item_data) for item_data in items_data]

        except Exception as e:
            logger.error(f"Error getting queue items: {e}")
            return []

    async def _save_all_items(self, community_id: int, items: List[QueueItem]):
        """Save all queue items for a community"""
        if self._fallback_enabled:
            self._fallback_queues[community_id] = items
            return

        if not self._connected:
            return

        try:
            key = self._make_key(community_id)

            # Convert to JSON
            items_data = [item.to_dict() for item in items]
            data = json.dumps(items_data)

            # Save with TTL
            await self._redis.setex(key, self.queue_ttl, data)

        except Exception as e:
            logger.error(f"Error saving queue items: {e}")

    async def _update_status(
        self,
        queue_id: str,
        community_id: int,
        status: QueueStatus
    ) -> bool:
        """Update the status of a queue item"""
        items = await self._get_all_items(community_id)

        for item in items:
            if item.id == queue_id:
                item.status = status
                await self._save_all_items(community_id, items)
                logger.info(
                    f"Updated queue item {queue_id} status to {status.value}"
                )
                return True

        return False

    async def _reposition_queue(self, community_id: int):
        """Reposition all queued items sequentially"""
        items = await self._get_all_items(community_id)

        # Get only queued items
        queued_items = [item for item in items if item.status == QueueStatus.QUEUED]

        # Update positions
        for i, item in enumerate(queued_items):
            item.position = i

        # Save
        await self._save_all_items(community_id, items)

    async def get_stats(self, community_id: int) -> Dict[str, Any]:
        """
        Get queue statistics for a community.

        Args:
            community_id: ID of community

        Returns:
            Dictionary of statistics
        """
        items = await self._get_all_items(community_id)

        stats = {
            "total_items": len(items),
            "queued": len([i for i in items if i.status == QueueStatus.QUEUED]),
            "playing": len([i for i in items if i.status == QueueStatus.PLAYING]),
            "played": len([i for i in items if i.status == QueueStatus.PLAYED]),
            "skipped": len([i for i in items if i.status == QueueStatus.SKIPPED]),
            "providers": {}
        }

        # Count tracks per provider
        for item in items:
            if item.status == QueueStatus.QUEUED:
                provider = item.track.provider
                stats["providers"][provider] = stats["providers"].get(provider, 0) + 1

        return stats


def create_unified_queue(
    redis_url: Optional[str],
    namespace: str = "music_queue",
    queue_ttl: int = 86400
) -> UnifiedQueue:
    """
    Factory function to create a unified queue manager.

    Args:
        redis_url: Redis connection URL
        namespace: Queue namespace
        queue_ttl: TTL for queue items in seconds (default 24 hours)

    Returns:
        Configured UnifiedQueue instance
    """
    return UnifiedQueue(
        redis_url=redis_url,
        namespace=namespace,
        queue_ttl=queue_ttl,
        enable_fallback=True
    )
