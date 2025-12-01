"""
Community Service - Handles community data queries.

Gracefully handles missing tables when dependent modules are not yet deployed.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

from config import Config

logger = logging.getLogger(__name__)


class CommunityService:
    """Service for community data operations."""

    def __init__(self, dal):
        self.dal = dal

    def _table_exists(self, db, table_name: str) -> bool:
        """Check if a table exists in the database."""
        return table_name in db.tables

    async def get_public_communities(
        self,
        page: int = 1,
        per_page: int = None
    ) -> Dict[str, Any]:
        """Get list of public communities with pagination."""
        per_page = per_page or Config.DEFAULT_PAGE_SIZE
        per_page = min(per_page, Config.MAX_PAGE_SIZE)
        offset = (page - 1) * per_page

        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'communities'):
                    return 0, []

                query = db.communities.is_active == True  # noqa: E712
                total = db(query).count()
                rows = db(query).select(
                    db.communities.id,
                    db.communities.name,
                    db.communities.display_name,
                    db.communities.description,
                    db.communities.logo_url,
                    db.communities.primary_platform,
                    db.communities.member_count,
                    db.communities.created_at,
                    orderby=db.communities.name,
                    limitby=(offset, offset + per_page)
                )
                return total, list(rows)
            except Exception as e:
                logger.error(f"Error in get_public_communities: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return 0, []

        loop = asyncio.get_event_loop()
        total, rows = await loop.run_in_executor(None, _query)

        communities = []
        for row in rows:
            communities.append({
                'id': row.id,
                'name': row.name,
                'display_name': row.display_name or row.name,
                'description': row.description,
                'logo_url': row.logo_url,
                'primary_platform': row.primary_platform,
                'member_count': row.member_count or 0,
                'created_at': row.created_at.isoformat() if row.created_at else None
            })

        return {
            'communities': communities,
            'total': total,
            'page': page,
            'per_page': per_page,
            'total_pages': max(1, (total + per_page - 1) // per_page)
        }

    async def get_community_public(self, community_id: int) -> Optional[Dict[str, Any]]:
        """Get public information about a single community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'communities'):
                    return None

                return db(
                    (db.communities.id == community_id) &
                    (db.communities.is_active == True)  # noqa: E712
                ).select().first()
            except Exception as e:
                logger.error(f"Error in get_community_public: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return None

        loop = asyncio.get_event_loop()
        row = await loop.run_in_executor(None, _query)

        if not row:
            return None

        return {
            'id': row.id,
            'name': row.name,
            'display_name': row.display_name or row.name,
            'description': row.description,
            'logo_url': row.logo_url,
            'banner_url': row.banner_url,
            'primary_platform': row.primary_platform,
            'member_count': row.member_count or 0,
            'created_at': row.created_at.isoformat() if row.created_at else None
        }

    async def get_community_detail(
        self,
        community_id: int,
        user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get detailed community info for authenticated user."""
        public_info = await self.get_community_public(community_id)
        if not public_info:
            return None

        # Get user's role in community
        user_role = await self.get_user_role(community_id, user_id)

        # Get entity groups
        entity_groups = await self.get_entity_groups(community_id)

        return {
            **public_info,
            'user_role': user_role,
            'entity_groups': entity_groups,
        }

    async def get_community_members(
        self,
        community_id: int,
        page: int = 1,
        per_page: int = None
    ) -> Dict[str, Any]:
        """Get paginated member list with reputation scores."""
        per_page = per_page or Config.DEFAULT_PAGE_SIZE
        per_page = min(per_page, Config.MAX_PAGE_SIZE)
        offset = (page - 1) * per_page

        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'community_members'):
                    return 0, []

                query = (
                    (db.community_members.community_id == community_id) &
                    (db.community_members.is_active == True)  # noqa: E712
                )
                total = db(query).count()

                members = db(query).select(
                    db.community_members.user_id,
                    db.community_members.display_name,
                    db.community_members.role,
                    db.community_members.reputation_score,
                    db.community_members.joined_at,
                    db.community_members.last_active,
                    orderby=~db.community_members.reputation_score,
                    limitby=(offset, offset + per_page)
                )
                return total, list(members)
            except Exception as e:
                logger.error(f"Error in get_community_members: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return 0, []

        loop = asyncio.get_event_loop()
        total, members = await loop.run_in_executor(None, _query)

        member_list = []
        for m in members:
            member_list.append({
                'user_id': m.user_id,
                'display_name': m.display_name,
                'role': m.role or 'member',
                'reputation_score': m.reputation_score or 0,
                'joined_at': m.joined_at.isoformat() if m.joined_at else None,
                'last_active': m.last_active.isoformat() if m.last_active else None,
            })

        return {
            'members': member_list,
            'total': total,
            'page': page,
            'per_page': per_page,
            'total_pages': max(1, (total + per_page - 1) // per_page)
        }

    async def get_member_count(self, community_id: int) -> int:
        """Get count of active members in community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'community_members'):
                    return 0

                return db(
                    (db.community_members.community_id == community_id) &
                    (db.community_members.is_active == True)  # noqa: E712
                ).count()
            except Exception as e:
                logger.error(f"Error in get_member_count: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return 0

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_platform_stats(self, community_id: int) -> Dict[str, int]:
        """Get count of entities per platform for community."""
        def _query():
            stats = {'discord': 0, 'twitch': 0, 'slack': 0}
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'entity_groups'):
                    return stats

                groups = db(
                    (db.entity_groups.community_id == community_id) &
                    (db.entity_groups.is_active == True)  # noqa: E712
                ).select()

                for group in groups:
                    platform = group.platform.lower() if group.platform else ''
                    if platform in stats:
                        stats[platform] += 1

            except Exception as e:
                logger.error(f"Error in get_platform_stats: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass

            return stats

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_user_role(self, community_id: int, user_id: str) -> str:
        """Get user's role in community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'community_members'):
                    return 'member'

                member = db(
                    (db.community_members.community_id == community_id) &
                    (db.community_members.user_id == user_id) &
                    (db.community_members.is_active == True)  # noqa: E712
                ).select().first()
                return member.role if member and member.role else 'member'
            except Exception as e:
                logger.error(f"Error in get_user_role: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return 'member'

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_user_reputation(self, community_id: int, user_id: str) -> int:
        """Get user's reputation score in community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'community_members'):
                    return 0

                member = db(
                    (db.community_members.community_id == community_id) &
                    (db.community_members.user_id == user_id)
                ).select().first()
                return member.reputation_score if member else 0
            except Exception as e:
                logger.error(f"Error in get_user_reputation: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return 0

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_entity_groups(self, community_id: int) -> List[Dict[str, Any]]:
        """Get entity groups for community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'entity_groups'):
                    return []

                groups = db(
                    (db.entity_groups.community_id == community_id) &
                    (db.entity_groups.is_active == True)  # noqa: E712
                ).select()
                return [
                    {
                        'id': g.id,
                        'name': g.name,
                        'platform': g.platform,
                        'entity_count': len(g.entity_ids) if g.entity_ids else 0
                    }
                    for g in groups
                ]
            except Exception as e:
                logger.error(f"Error in get_entity_groups: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return []

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def is_user_member(self, community_id: int, user_id: str) -> bool:
        """Check if user is a member of community."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'community_members'):
                    return False

                return db(
                    (db.community_members.community_id == community_id) &
                    (db.community_members.user_id == user_id) &
                    (db.community_members.is_active == True)  # noqa: E712
                ).count() > 0
            except Exception as e:
                logger.error(f"Error in is_user_member: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return False

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)
