"""
Module Integration Service - Fetches data from other WaddleBot modules.

Aggregates data from Inventory, Reputation, Calendar, Memories, and other
modules based on user permissions.
"""
import asyncio
from typing import Any, Dict, List, Optional

import httpx

from config import Config


class ModuleIntegrationService:
    """Service for integrating with other WaddleBot modules."""

    def __init__(self, dal):
        self.dal = dal
        self.module_urls = {
            'inventory': Config.INVENTORY_API_URL,
            'reputation': Config.REPUTATION_API_URL,
            'calendar': Config.CALENDAR_API_URL,
            'memories': Config.MEMORIES_API_URL,
            'labels': Config.LABELS_API_URL,
            'shoutout': Config.SHOUTOUT_API_URL,
        }
        self.timeout = 10.0

    async def check_user_permission(
        self,
        community_id: int,
        user_id: str,
        permission: str
    ) -> bool:
        """Check if user has specific permission via Labels module."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['labels']}/api/v1/users/{user_id}/labels",
                    params={'community_id': community_id},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    labels = data.get('labels', [])
                    return permission in labels
                return False
        except Exception:
            return False

    async def get_reputation_leaderboard(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Get top users by reputation in community."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['reputation']}/api/v1/leaderboard",
                    params={
                        'community_id': community_id,
                        'limit': limit
                    },
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    return response.json().get('leaderboard', [])
                return []
        except Exception:
            # Fallback to local database query
            return await self._get_local_leaderboard(community_id, limit)

    async def _get_local_leaderboard(
        self,
        community_id: int,
        limit: int
    ) -> List[Dict[str, Any]]:
        """Fallback local leaderboard query."""
        def _query():
            db = self.dal.dal
            rows = db(
                db.user_reputation.community_id == community_id
            ).select(
                orderby=~db.user_reputation.current_score,
                limitby=(0, limit)
            )
            return [
                {
                    'rank': i + 1,
                    'user_id': r.user_id,
                    'score': r.current_score
                }
                for i, r in enumerate(rows)
            ]

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_community_inventory(
        self,
        community_id: int,
        user_id: str
    ) -> Dict[str, Any]:
        """Get inventory items for community (requires inventory:view permission)."""
        # Check permission
        has_permission = await self.check_user_permission(
            community_id, user_id, 'inventory:view'
        )

        if not has_permission:
            return {'authorized': False, 'items': []}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['inventory']}/api/v1/items",
                    params={'community_id': community_id},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    return {
                        'authorized': True,
                        'items': data.get('items', []),
                        'total': data.get('total', 0)
                    }
                return {'authorized': True, 'items': [], 'error': 'Module unavailable'}
        except Exception as e:
            return {'authorized': True, 'items': [], 'error': str(e)}

    async def get_upcoming_events(
        self,
        community_id: int,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """Get upcoming calendar events for community."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['calendar']}/api/v1/events",
                    params={
                        'community_id': community_id,
                        'limit': limit,
                        'status': 'approved',
                        'upcoming': 'true'
                    },
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    return response.json().get('events', [])
                return []
        except Exception:
            return []

    async def get_community_memories(
        self,
        community_id: int,
        user_id: str,
        memory_type: Optional[str] = None,
        limit: int = 10
    ) -> Dict[str, Any]:
        """Get community memories (requires memories:view permission)."""
        # Check permission
        has_permission = await self.check_user_permission(
            community_id, user_id, 'memories:view'
        )

        if not has_permission:
            return {'authorized': False, 'memories': []}

        try:
            params = {
                'community_id': community_id,
                'limit': limit
            }
            if memory_type:
                params['type'] = memory_type

            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['memories']}/api/v1/memories",
                    params=params,
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    return {
                        'authorized': True,
                        'memories': data.get('memories', [])
                    }
                return {'authorized': True, 'memories': [], 'error': 'Module unavailable'}
        except Exception as e:
            return {'authorized': True, 'memories': [], 'error': str(e)}

    async def get_recent_quotes(
        self,
        community_id: int,
        user_id: str,
        limit: int = 5
    ) -> Dict[str, Any]:
        """Get recent quotes from memories module."""
        return await self.get_community_memories(
            community_id, user_id, memory_type='quote', limit=limit
        )

    async def get_recent_shoutouts(
        self,
        community_id: int,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """Get recent shoutouts (public)."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['shoutout']}/api/v1/shoutouts",
                    params={
                        'community_id': community_id,
                        'limit': limit
                    },
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    return response.json().get('shoutouts', [])
                return []
        except Exception:
            return []

    async def get_user_labels(
        self,
        community_id: int,
        user_id: str
    ) -> List[str]:
        """Get labels/badges for user in community."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.module_urls['labels']}/api/v1/users/{user_id}/labels",
                    params={'community_id': community_id},
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    return response.json().get('labels', [])
                return []
        except Exception:
            return []

    async def get_hub_dashboard_data(
        self,
        community_id: int,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get aggregated dashboard data for community hub."""
        # Run all fetches in parallel
        tasks = [
            self.get_reputation_leaderboard(community_id, limit=5),
            self.get_upcoming_events(community_id, limit=5),
            self.get_recent_shoutouts(community_id, limit=5),
        ]

        # Add permission-based data if user is authenticated
        if user_id:
            tasks.extend([
                self.get_community_inventory(community_id, user_id),
                self.get_recent_quotes(community_id, user_id, limit=5),
                self.get_user_labels(community_id, user_id),
            ])

        results = await asyncio.gather(*tasks, return_exceptions=True)

        dashboard = {
            'leaderboard': results[0] if not isinstance(results[0], Exception) else [],
            'events': results[1] if not isinstance(results[1], Exception) else [],
            'shoutouts': results[2] if not isinstance(results[2], Exception) else [],
        }

        if user_id:
            dashboard['inventory'] = results[3] if not isinstance(results[3], Exception) else {'authorized': False}
            dashboard['quotes'] = results[4] if not isinstance(results[4], Exception) else {'authorized': False}
            dashboard['user_labels'] = results[5] if not isinstance(results[5], Exception) else []

        return dashboard
