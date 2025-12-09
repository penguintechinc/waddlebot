"""
AI Interaction Cache Manager

Implements distributed caching for:
- AI responses for common queries (TTL: 3600s)
- User conversation context (TTL: 1800s)
- Frequently used prompts (TTL: 7200s)
"""

import logging
from typing import Dict, Any, Optional, List
from flask_core import CacheManager

logger = logging.getLogger(__name__)


class AICacheManager:
    """
    Cache manager for AI interaction module.

    Caches:
    - responses: Common query responses to reduce AI API calls
    - contexts: User conversation contexts
    - prompts: Frequently used system prompts
    """

    # Cache TTLs in seconds
    RESPONSE_TTL = 3600  # 1 hour for common responses
    CONTEXT_TTL = 1800  # 30 minutes for conversation context
    PROMPT_TTL = 7200  # 2 hours for system prompts

    def __init__(self, cache: CacheManager):
        """
        Initialize AI cache manager.

        Args:
            cache: Configured CacheManager instance
        """
        self.cache = cache

    def _make_response_key(
        self,
        message: str,
        message_type: str,
        platform: str
    ) -> str:
        """Generate cache key for response"""
        # Create a normalized key from message (lowercase, trimmed)
        normalized = message.lower().strip()[:100]  # Limit key length
        return f"response:{platform}:{message_type}:{normalized}"

    async def get_cached_response(
        self,
        message: str,
        message_type: str,
        platform: str
    ) -> Optional[str]:
        """
        Get cached AI response for a message.

        Args:
            message: Input message
            message_type: Type of message (chatMessage, etc.)
            platform: Platform (twitch, discord, etc.)

        Returns:
            Cached response or None
        """
        key = self._make_response_key(message, message_type, platform)
        return await self.cache.get(key)

    async def cache_response(
        self,
        message: str,
        message_type: str,
        platform: str,
        response: str,
        ttl: Optional[int] = None
    ) -> bool:
        """
        Cache an AI response.

        Args:
            message: Input message
            message_type: Type of message
            platform: Platform
            response: AI response to cache
            ttl: Custom TTL (defaults to RESPONSE_TTL)

        Returns:
            True if successful
        """
        key = self._make_response_key(message, message_type, platform)
        return await self.cache.set(
            key,
            response,
            ttl=ttl or self.RESPONSE_TTL
        )

    async def get_conversation_context(
        self,
        user_id: str,
        platform: str
    ) -> Optional[List[Dict[str, Any]]]:
        """
        Get cached conversation context for a user.

        Args:
            user_id: User identifier
            platform: Platform

        Returns:
            List of message dictionaries or None
        """
        key = f"context:{platform}:{user_id}"
        return await self.cache.get(key)

    async def set_conversation_context(
        self,
        user_id: str,
        platform: str,
        context: List[Dict[str, Any]]
    ) -> bool:
        """
        Cache conversation context for a user.

        Args:
            user_id: User identifier
            platform: Platform
            context: List of message dictionaries

        Returns:
            True if successful
        """
        key = f"context:{platform}:{user_id}"
        return await self.cache.set(
            key,
            context,
            ttl=self.CONTEXT_TTL
        )

    async def append_to_context(
        self,
        user_id: str,
        platform: str,
        message: Dict[str, Any],
        max_context_length: int = 10
    ) -> bool:
        """
        Append a message to user's conversation context.

        Args:
            user_id: User identifier
            platform: Platform
            message: Message to append
            max_context_length: Maximum context messages to keep

        Returns:
            True if successful
        """
        # Get existing context
        context = await self.get_conversation_context(user_id, platform)
        if context is None:
            context = []

        # Append new message
        context.append(message)

        # Keep only last N messages
        if len(context) > max_context_length:
            context = context[-max_context_length:]

        # Save back to cache
        return await self.set_conversation_context(user_id, platform, context)

    async def clear_conversation_context(
        self,
        user_id: str,
        platform: str
    ) -> bool:
        """Clear conversation context for a user"""
        key = f"context:{platform}:{user_id}"
        return await self.cache.delete(key)

    async def get_system_prompt(
        self,
        prompt_type: str = "default"
    ) -> Optional[str]:
        """Get cached system prompt"""
        key = f"prompt:{prompt_type}"
        return await self.cache.get(key)

    async def set_system_prompt(
        self,
        prompt: str,
        prompt_type: str = "default"
    ) -> bool:
        """Cache system prompt"""
        key = f"prompt:{prompt_type}"
        return await self.cache.set(
            key,
            prompt,
            ttl=self.PROMPT_TTL
        )

    async def increment_response_hits(
        self,
        message: str,
        message_type: str,
        platform: str
    ) -> Optional[int]:
        """
        Track how many times a cached response was used.

        Useful for identifying most common queries.

        Returns:
            Hit count or None
        """
        key = self._make_response_key(message, message_type, platform)
        hits_key = f"{key}:hits"
        return await self.cache.increment(hits_key)

    async def get_popular_queries(
        self,
        limit: int = 10
    ) -> List[str]:
        """
        Get most popular cached queries.

        Note: This is a basic implementation. For production,
        consider using Redis sorted sets for better performance.

        Returns:
            List of popular query keys
        """
        # This would require pattern scanning which is expensive
        # In production, use Redis ZSET for tracking popularity
        logger.warning("get_popular_queries not fully implemented")
        return []

    async def invalidate_platform_cache(self, platform: str):
        """Invalidate all caches for a platform"""
        await self.cache.delete_pattern(f"response:{platform}:*")
        await self.cache.delete_pattern(f"context:{platform}:*")
        logger.info(f"Invalidated all caches for platform: {platform}")

    async def invalidate_all(self):
        """Invalidate entire AI cache"""
        await self.cache.delete_pattern("response:*")
        await self.cache.delete_pattern("context:*")
        await self.cache.delete_pattern("prompt:*")
        logger.info("Invalidated all AI caches")

    async def warm_common_queries(
        self,
        common_queries: Dict[str, str],
        platform: str = "all"
    ):
        """
        Warm cache with common queries and responses.

        Args:
            common_queries: Dict of message -> response
            platform: Platform to warm for
        """
        if not common_queries:
            logger.warning("No common queries to warm cache")
            return

        try:
            cache_items = {}
            for message, response in common_queries.items():
                key = self._make_response_key(message, "chatMessage", platform)
                # Remove namespace prefix since cache.set_many will add it
                cache_items[key] = response

            await self.cache.set_many(cache_items, ttl=self.RESPONSE_TTL)

            logger.info(
                f"Warmed AI cache with {len(common_queries)} common queries "
                f"for platform: {platform}"
            )

        except Exception as e:
            logger.error(f"Failed to warm AI cache: {e}")

    async def get_cache_efficiency(self) -> Dict[str, Any]:
        """
        Get cache efficiency metrics.

        Returns:
            Dictionary with cache statistics
        """
        base_stats = await self.cache.get_stats()

        # Could add more AI-specific metrics here
        # For example: hit rate, most popular queries, etc.

        return {
            **base_stats,
            "cached_response_ttl": self.RESPONSE_TTL,
            "context_ttl": self.CONTEXT_TTL,
            "prompt_ttl": self.PROMPT_TTL
        }
