"""
Calendar Interaction Cache Manager

Implements distributed caching for:
- Upcoming events per community (TTL: 300s)
- Event details (TTL: 600s)
- User event lists (TTL: 300s)
"""

import logging
from typing import Dict, Any, Optional, List
from flask_core import CacheManager

logger = logging.getLogger(__name__)


class CalendarCacheManager:
    """
    Cache manager for Calendar interaction module.

    Caches:
    - events: Upcoming events per community
    - event_details: Individual event information
    - user_events: Events per user
    """

    # Cache TTLs in seconds
    EVENTS_LIST_TTL = 300  # 5 minutes for event lists
    EVENT_DETAIL_TTL = 600  # 10 minutes for event details
    USER_EVENTS_TTL = 300  # 5 minutes for user event lists

    def __init__(self, cache: CacheManager):
        """
        Initialize Calendar cache manager.

        Args:
            cache: Configured CacheManager instance
        """
        self.cache = cache

    async def get_upcoming_events(
        self,
        community_id: int,
        limit: int = 10
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached upcoming events for a community"""
        key = f"events:upcoming:{community_id}:{limit}"
        return await self.cache.get(key)

    async def set_upcoming_events(
        self,
        community_id: int,
        events: List[Dict[str, Any]],
        limit: int = 10
    ) -> bool:
        """Cache upcoming events for a community"""
        key = f"events:upcoming:{community_id}:{limit}"
        return await self.cache.set(
            key,
            events,
            ttl=self.EVENTS_LIST_TTL
        )

    async def get_event(self, event_id: int) -> Optional[Dict[str, Any]]:
        """Get cached event details"""
        key = f"event:detail:{event_id}"
        return await self.cache.get(key)

    async def set_event(
        self,
        event_id: int,
        event: Dict[str, Any]
    ) -> bool:
        """Cache event details"""
        key = f"event:detail:{event_id}"
        return await self.cache.set(
            key,
            event,
            ttl=self.EVENT_DETAIL_TTL
        )

    async def get_user_events(
        self,
        user_id: int,
        community_id: int
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached events for a user"""
        key = f"events:user:{user_id}:{community_id}"
        return await self.cache.get(key)

    async def set_user_events(
        self,
        user_id: int,
        community_id: int,
        events: List[Dict[str, Any]]
    ) -> bool:
        """Cache events for a user"""
        key = f"events:user:{user_id}:{community_id}"
        return await self.cache.set(
            key,
            events,
            ttl=self.USER_EVENTS_TTL
        )

    async def invalidate_event(self, event_id: int):
        """
        Invalidate all caches related to an event.

        Called when an event is created, updated, or deleted.
        """
        # Invalidate event detail
        await self.cache.delete(f"event:detail:{event_id}")

        # Invalidate all event lists (community and user)
        # This is broad but ensures consistency
        await self.cache.delete_pattern("events:upcoming:*")
        await self.cache.delete_pattern("events:user:*")

        logger.info(f"Invalidated caches for event: {event_id}")

    async def invalidate_community_events(self, community_id: int):
        """Invalidate all event caches for a community"""
        await self.cache.delete_pattern(f"events:upcoming:{community_id}:*")
        await self.cache.delete_pattern(f"events:user:*:{community_id}")
        logger.info(f"Invalidated event caches for community: {community_id}")

    async def invalidate_user_events(self, user_id: int):
        """Invalidate event caches for a user"""
        await self.cache.delete_pattern(f"events:user:{user_id}:*")
        logger.info(f"Invalidated event caches for user: {user_id}")

    async def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        base_stats = await self.cache.get_stats()
        base_stats.update({
            "events_list_ttl": self.EVENTS_LIST_TTL,
            "event_detail_ttl": self.EVENT_DETAIL_TTL,
            "user_events_ttl": self.USER_EVENTS_TTL
        })
        return base_stats
