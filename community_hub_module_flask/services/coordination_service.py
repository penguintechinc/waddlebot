"""
Coordination Service - Handles live stream and status queries.

Gracefully handles missing tables when dependent modules are not yet deployed.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class CoordinationService:
    """Service for live stream and coordination data."""

    def __init__(self, dal):
        self.dal = dal

    def _table_exists(self, db, table_name: str) -> bool:
        """Check if a table exists in the database."""
        return table_name in db.tables

    async def get_live_streams(
        self,
        limit: int = 10,
        community_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Get currently live streams with viewer counts."""
        def _query():
            try:
                db = self.dal.dal

                # Check if required table exists
                if not self._table_exists(db, 'coordination'):
                    logger.debug("coordination table not found, returning empty")
                    return []

                # Base query for live streams
                query = (
                    (db.coordination.is_live == True) &  # noqa: E712
                    (db.coordination.platform == 'twitch')
                )

                # If community_id provided, filter by community's entity groups
                if community_id and self._table_exists(db, 'entity_groups'):
                    entity_groups = db(
                        (db.entity_groups.community_id == community_id) &
                        (db.entity_groups.is_active == True) &  # noqa: E712
                        (db.entity_groups.platform == 'twitch')
                    ).select()

                    entity_ids = []
                    for group in entity_groups:
                        if group.entity_ids:
                            entity_ids.extend(group.entity_ids)

                    if entity_ids:
                        query &= db.coordination.entity_id.belongs(entity_ids)
                    else:
                        # No twitch entities in community
                        return []

                rows = db(query).select(
                    db.coordination.entity_id,
                    db.coordination.server_id,
                    db.coordination.channel_id,
                    db.coordination.viewer_count,
                    db.coordination.live_since,
                    db.coordination.metadata,
                    orderby=~db.coordination.viewer_count,
                    limitby=(0, limit)
                )
                return list(rows)
            except Exception as e:
                logger.error(f"Error in get_live_streams: {e}")
                db.rollback()
                return []

        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(None, _query)

        streams = []
        for row in rows:
            metadata = row.metadata or {}
            streams.append({
                'entity_id': row.entity_id,
                'channel_name': row.channel_id or row.server_id,
                'viewer_count': row.viewer_count or 0,
                'live_since': row.live_since.isoformat() if row.live_since else None,
                'title': metadata.get('title', ''),
                'game': metadata.get('game', ''),
                'thumbnail_url': metadata.get('thumbnail_url', ''),
            })

        return streams

    async def get_platform_stats(
        self,
        community_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Get aggregate statistics per platform."""
        def _query():
            stats = {
                'discord': {'servers': 0, 'channels': 0},
                'twitch': {'channels': 0, 'live': 0, 'total_viewers': 0},
                'slack': {'workspaces': 0, 'channels': 0}
            }

            try:
                db = self.dal.dal

                # Check if required table exists
                if not self._table_exists(db, 'coordination'):
                    return stats

                # Build entity filter if community_id provided
                entity_ids = None
                if community_id and self._table_exists(db, 'entity_groups'):
                    entity_groups = db(
                        (db.entity_groups.community_id == community_id) &
                        (db.entity_groups.is_active == True)  # noqa: E712
                    ).select()

                    entity_ids = []
                    for group in entity_groups:
                        if group.entity_ids:
                            entity_ids.extend(group.entity_ids)

                # Discord stats
                discord_query = db.coordination.platform == 'discord'
                if entity_ids is not None:
                    discord_query &= db.coordination.entity_id.belongs(entity_ids)

                discord_rows = db(discord_query).select(
                    db.coordination.server_id,
                    distinct=True
                )
                stats['discord']['servers'] = len(discord_rows)
                stats['discord']['channels'] = db(discord_query).count()

                # Twitch stats
                twitch_query = db.coordination.platform == 'twitch'
                if entity_ids is not None:
                    twitch_query &= db.coordination.entity_id.belongs(entity_ids)

                stats['twitch']['channels'] = db(twitch_query).count()

                live_query = twitch_query & (db.coordination.is_live == True)  # noqa: E712
                live_rows = db(live_query).select(db.coordination.viewer_count)
                stats['twitch']['live'] = len(live_rows)
                stats['twitch']['total_viewers'] = sum(
                    r.viewer_count or 0 for r in live_rows
                )

                # Slack stats
                slack_query = db.coordination.platform == 'slack'
                if entity_ids is not None:
                    slack_query &= db.coordination.entity_id.belongs(entity_ids)

                slack_rows = db(slack_query).select(
                    db.coordination.server_id,
                    distinct=True
                )
                stats['slack']['workspaces'] = len(slack_rows)
                stats['slack']['channels'] = db(slack_query).count()

            except Exception as e:
                logger.error(f"Error in get_platform_stats: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass

            return stats

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_stream_details(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed information about a specific stream."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'coordination'):
                    return None

                row = db(db.coordination.entity_id == entity_id).select().first()
                if not row:
                    return None

                metadata = row.metadata or {}
                return {
                    'entity_id': row.entity_id,
                    'platform': row.platform,
                    'channel_name': row.channel_id or row.server_id,
                    'is_live': row.is_live,
                    'viewer_count': row.viewer_count or 0,
                    'live_since': row.live_since.isoformat() if row.live_since else None,
                    'last_activity': row.last_activity.isoformat() if row.last_activity else None,
                    'title': metadata.get('title', ''),
                    'game': metadata.get('game', ''),
                    'thumbnail_url': metadata.get('thumbnail_url', ''),
                    'profile_image': metadata.get('profile_image', ''),
                }
            except Exception as e:
                logger.error(f"Error in get_stream_details: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return None

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_recently_live(
        self,
        limit: int = 10,
        community_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Get recently live streams (went offline in last 24 hours)."""
        def _query():
            try:
                db = self.dal.dal

                if not self._table_exists(db, 'coordination'):
                    return []

                cutoff = datetime.utcnow() - timedelta(hours=24)

                query = (
                    (db.coordination.is_live == False) &  # noqa: E712
                    (db.coordination.platform == 'twitch') &
                    (db.coordination.live_since != None) &
                    (db.coordination.live_since > cutoff)
                )

                if community_id and self._table_exists(db, 'entity_groups'):
                    entity_groups = db(
                        (db.entity_groups.community_id == community_id) &
                        (db.entity_groups.is_active == True) &  # noqa: E712
                        (db.entity_groups.platform == 'twitch')
                    ).select()

                    entity_ids = []
                    for group in entity_groups:
                        if group.entity_ids:
                            entity_ids.extend(group.entity_ids)

                    if entity_ids:
                        query &= db.coordination.entity_id.belongs(entity_ids)
                    else:
                        return []

                rows = db(query).select(
                    orderby=~db.coordination.live_since,
                    limitby=(0, limit)
                )
                return list(rows)
            except Exception as e:
                logger.error(f"Error in get_recently_live: {e}")
                try:
                    self.dal.dal.rollback()
                except Exception:
                    pass
                return []

        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(None, _query)

        streams = []
        for row in rows:
            metadata = row.metadata or {}
            streams.append({
                'entity_id': row.entity_id,
                'channel_name': row.channel_id or row.server_id,
                'last_live': row.live_since.isoformat() if row.live_since else None,
                'title': metadata.get('title', ''),
                'game': metadata.get('game', ''),
            })

        return streams
