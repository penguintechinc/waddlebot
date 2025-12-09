"""
Loyalty Interaction Cache Manager

Implements distributed caching for:
- Leaderboards (TTL: 60s)
- User balances (TTL: 30s)
- Gear inventory (TTL: 120s)
"""

import logging
from typing import Dict, Any, Optional, List
from flask_core import CacheManager

logger = logging.getLogger(__name__)


class LoyaltyCacheManager:
    """
    Cache manager for Loyalty interaction module.

    Caches:
    - leaderboards: Community point rankings
    - balances: User point balances
    - gear: User gear inventory
    - stats: Community statistics
    """

    # Cache TTLs in seconds
    LEADERBOARD_TTL = 60  # 1 minute for leaderboards (hot data)
    BALANCE_TTL = 30  # 30 seconds for user balances (very hot data)
    GEAR_TTL = 120  # 2 minutes for gear inventory
    STATS_TTL = 300  # 5 minutes for community stats

    def __init__(self, cache: CacheManager):
        """
        Initialize Loyalty cache manager.

        Args:
            cache: Configured CacheManager instance
        """
        self.cache = cache

    async def get_leaderboard(
        self,
        community_id: int,
        limit: int = 10
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached leaderboard for a community"""
        key = f"leaderboard:{community_id}:{limit}"
        return await self.cache.get(key)

    async def set_leaderboard(
        self,
        community_id: int,
        leaderboard: List[Dict[str, Any]],
        limit: int = 10
    ) -> bool:
        """Cache leaderboard for a community"""
        key = f"leaderboard:{community_id}:{limit}"
        return await self.cache.set(
            key,
            leaderboard,
            ttl=self.LEADERBOARD_TTL
        )

    async def get_user_balance(
        self,
        user_id: int,
        community_id: int
    ) -> Optional[int]:
        """Get cached user balance"""
        key = f"balance:{user_id}:{community_id}"
        return await self.cache.get(key)

    async def set_user_balance(
        self,
        user_id: int,
        community_id: int,
        balance: int
    ) -> bool:
        """Cache user balance"""
        key = f"balance:{user_id}:{community_id}"
        return await self.cache.set(
            key,
            balance,
            ttl=self.BALANCE_TTL
        )

    async def invalidate_user_balance(
        self,
        user_id: int,
        community_id: int
    ):
        """
        Invalidate user balance cache.

        Called after point transactions (add/subtract/transfer).
        """
        await self.cache.delete(f"balance:{user_id}:{community_id}")

    async def get_user_gear(
        self,
        user_id: int,
        community_id: int
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached user gear inventory"""
        key = f"gear:{user_id}:{community_id}"
        return await self.cache.get(key)

    async def set_user_gear(
        self,
        user_id: int,
        community_id: int,
        gear: List[Dict[str, Any]]
    ) -> bool:
        """Cache user gear inventory"""
        key = f"gear:{user_id}:{community_id}"
        return await self.cache.set(
            key,
            gear,
            ttl=self.GEAR_TTL
        )

    async def invalidate_user_gear(
        self,
        user_id: int,
        community_id: int
    ):
        """
        Invalidate user gear cache.

        Called after gear purchases/equips/unequips.
        """
        await self.cache.delete(f"gear:{user_id}:{community_id}")

    async def get_community_stats(
        self,
        community_id: int
    ) -> Optional[Dict[str, Any]]:
        """Get cached community statistics"""
        key = f"stats:{community_id}"
        return await self.cache.get(key)

    async def set_community_stats(
        self,
        community_id: int,
        stats: Dict[str, Any]
    ) -> bool:
        """Cache community statistics"""
        key = f"stats:{community_id}"
        return await self.cache.set(
            key,
            stats,
            ttl=self.STATS_TTL
        )

    async def get_available_gear(
        self,
        community_id: int
    ) -> Optional[List[Dict[str, Any]]]:
        """Get cached available gear for purchase"""
        key = f"gear:available:{community_id}"
        return await self.cache.get(key)

    async def set_available_gear(
        self,
        community_id: int,
        gear_list: List[Dict[str, Any]]
    ) -> bool:
        """Cache available gear for purchase"""
        key = f"gear:available:{community_id}"
        return await self.cache.set(
            key,
            gear_list,
            ttl=self.GEAR_TTL
        )

    async def invalidate_leaderboard(self, community_id: int):
        """
        Invalidate leaderboard cache.

        Called after any point transaction that could affect rankings.
        """
        await self.cache.delete_pattern(f"leaderboard:{community_id}:*")
        logger.debug(f"Invalidated leaderboard for community: {community_id}")

    async def invalidate_community(self, community_id: int):
        """Invalidate all caches for a community"""
        await self.cache.delete_pattern(f"leaderboard:{community_id}:*")
        await self.cache.delete_pattern(f"balance:*:{community_id}")
        await self.cache.delete_pattern(f"gear:*:{community_id}")
        await self.cache.delete(f"stats:{community_id}")
        await self.cache.delete(f"gear:available:{community_id}")
        logger.info(f"Invalidated all caches for community: {community_id}")

    async def increment_user_balance_cache(
        self,
        user_id: int,
        community_id: int,
        amount: int
    ) -> Optional[int]:
        """
        Atomically increment cached user balance.

        Note: This only works if balance is cached as integer.
        Useful for high-frequency operations.

        Returns:
            New balance or None if not cached
        """
        key = f"balance:{user_id}:{community_id}"
        cached_balance = await self.cache.get(key)

        if cached_balance is not None:
            new_balance = cached_balance + amount
            await self.set_user_balance(user_id, community_id, new_balance)
            return new_balance

        return None

    async def warm_leaderboards(
        self,
        community_leaderboards: Dict[int, List[Dict[str, Any]]]
    ):
        """
        Warm cache with leaderboard data.

        Args:
            community_leaderboards: Dict of community_id -> leaderboard
        """
        if not community_leaderboards:
            logger.warning("No leaderboards to warm cache")
            return

        try:
            cache_items = {}
            for community_id, leaderboard in community_leaderboards.items():
                key = f"leaderboard:{community_id}:10"
                cache_items[key] = leaderboard

            await self.cache.set_many(
                cache_items,
                ttl=self.LEADERBOARD_TTL
            )

            logger.info(
                f"Warmed loyalty cache with {len(community_leaderboards)} "
                "leaderboards"
            )

        except Exception as e:
            logger.error(f"Failed to warm loyalty cache: {e}")

    async def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        base_stats = await self.cache.get_stats()
        base_stats.update({
            "leaderboard_ttl": self.LEADERBOARD_TTL,
            "balance_ttl": self.BALANCE_TTL,
            "gear_ttl": self.GEAR_TTL,
            "stats_ttl": self.STATS_TTL
        })
        return base_stats
