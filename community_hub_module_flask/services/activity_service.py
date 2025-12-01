"""
Activity Service - Handles cross-platform activity feed.
"""
import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional


class ActivityService:
    """Service for cross-platform activity feed."""

    # Human-readable event type names
    EVENT_TYPE_LABELS = {
        'follow': 'followed',
        'subscription': 'subscribed',
        'sub': 'subscribed',
        'resub': 'resubscribed',
        'subgift': 'gifted subscription',
        'cheer': 'cheered',
        'bits': 'cheered',
        'raid': 'raided',
        'host': 'hosted',
        'message': 'sent message',
        'reaction': 'reacted',
        'member_join': 'joined',
        'voice_join': 'joined voice',
        'boost': 'boosted server',
        'donation': 'donated',
    }

    def __init__(self, dal):
        self.dal = dal

    async def get_community_activity(
        self,
        community_id: int,
        limit: int = 20,
        since: Optional[datetime] = None,
        event_types: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Get recent activity events for community."""
        def _query():
            db = self.dal.dal

            query = db.reputation_events.community_id == community_id

            if since:
                query &= db.reputation_events.processed_at > since

            if event_types:
                query &= db.reputation_events.event_name.belongs(event_types)

            rows = db(query).select(
                db.reputation_events.id,
                db.reputation_events.user_id,
                db.reputation_events.entity_id,
                db.reputation_events.event_name,
                db.reputation_events.event_score,
                db.reputation_events.event_data,
                db.reputation_events.processed_at,
                orderby=~db.reputation_events.processed_at,
                limitby=(0, limit)
            )
            return rows

        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(None, _query)

        activities = []
        for row in rows:
            # Extract platform from entity_id (format: platform:server:channel)
            platform = 'unknown'
            if row.entity_id and ':' in row.entity_id:
                platform = row.entity_id.split(':')[0]

            event_data = row.event_data or {}
            activities.append({
                'id': row.id,
                'user_id': row.user_id,
                'user_name': event_data.get('user_name', row.user_id),
                'platform': platform,
                'event_type': row.event_name,
                'event_label': self.EVENT_TYPE_LABELS.get(row.event_name, row.event_name),
                'points': row.event_score,
                'details': event_data,
                'timestamp': row.processed_at.isoformat() if row.processed_at else None,
                'relative_time': self._relative_time(row.processed_at)
            })

        return activities

    async def get_user_activity(
        self,
        community_id: int,
        user_id: str,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """Get activity for a specific user in community."""
        def _query():
            db = self.dal.dal

            rows = db(
                (db.reputation_events.community_id == community_id) &
                (db.reputation_events.user_id == user_id)
            ).select(
                orderby=~db.reputation_events.processed_at,
                limitby=(0, limit)
            )
            return rows

        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(None, _query)

        activities = []
        for row in rows:
            platform = 'unknown'
            if row.entity_id and ':' in row.entity_id:
                platform = row.entity_id.split(':')[0]

            event_data = row.event_data or {}
            activities.append({
                'id': row.id,
                'platform': platform,
                'event_type': row.event_name,
                'event_label': self.EVENT_TYPE_LABELS.get(row.event_name, row.event_name),
                'points': row.event_score,
                'details': event_data,
                'timestamp': row.processed_at.isoformat() if row.processed_at else None,
                'relative_time': self._relative_time(row.processed_at)
            })

        return activities

    async def get_activity_summary(
        self,
        community_id: int,
        hours: int = 24
    ) -> Dict[str, Any]:
        """Get summary of activity in last N hours."""
        def _query():
            db = self.dal.dal

            cutoff = datetime.utcnow() - timedelta(hours=hours)

            rows = db(
                (db.reputation_events.community_id == community_id) &
                (db.reputation_events.processed_at > cutoff)
            ).select()

            summary = {
                'total_events': len(rows),
                'total_points': 0,
                'unique_users': set(),
                'by_platform': {},
                'by_event_type': {}
            }

            for row in rows:
                summary['total_points'] += row.event_score or 0
                summary['unique_users'].add(row.user_id)

                # Count by platform
                platform = 'unknown'
                if row.entity_id and ':' in row.entity_id:
                    platform = row.entity_id.split(':')[0]

                if platform not in summary['by_platform']:
                    summary['by_platform'][platform] = 0
                summary['by_platform'][platform] += 1

                # Count by event type
                if row.event_name not in summary['by_event_type']:
                    summary['by_event_type'][row.event_name] = 0
                summary['by_event_type'][row.event_name] += 1

            summary['unique_users'] = len(summary['unique_users'])
            return summary

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_leaderboard(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Get top users by reputation score."""
        def _query():
            db = self.dal.dal

            rows = db(
                db.user_reputation.community_id == community_id
            ).select(
                orderby=~db.user_reputation.current_score,
                limitby=(0, limit)
            )
            return rows

        loop = asyncio.get_event_loop()
        rows = await loop.run_in_executor(None, _query)

        leaderboard = []
        for rank, row in enumerate(rows, 1):
            leaderboard.append({
                'rank': rank,
                'user_id': row.user_id,
                'score': row.current_score,
                'total_events': row.total_events,
                'last_activity': row.last_activity.isoformat() if row.last_activity else None
            })

        return leaderboard

    def _relative_time(self, dt: Optional[datetime]) -> str:
        """Convert datetime to relative time string."""
        if not dt:
            return 'unknown'

        now = datetime.utcnow()
        diff = now - dt

        if diff.total_seconds() < 60:
            return 'just now'
        elif diff.total_seconds() < 3600:
            minutes = int(diff.total_seconds() / 60)
            return f'{minutes}m ago'
        elif diff.total_seconds() < 86400:
            hours = int(diff.total_seconds() / 3600)
            return f'{hours}h ago'
        elif diff.days < 7:
            return f'{diff.days}d ago'
        else:
            return dt.strftime('%b %d')
