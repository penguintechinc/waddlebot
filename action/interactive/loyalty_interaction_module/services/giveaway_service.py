"""
Giveaway Service with Reputation Integration
Manages giveaways with reputation-weighted entries and shadow banning
"""
import logging
import random
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
import httpx

logger = logging.getLogger(__name__)


@dataclass
class GiveawayInfo:
    """Giveaway information"""
    id: int
    community_id: int
    title: str
    description: str
    prize_description: str
    entry_cost: int
    max_entries_per_user: int
    reputation_floor: int
    weighted_by_reputation: bool
    status: str
    starts_at: datetime
    ends_at: datetime
    entry_count: int = 0


class GiveawayService:
    """
    Giveaway management with reputation integration.

    Features:
    - Free or currency-cost entries
    - Reputation floor for eligibility
    - Shadow banning (below-floor users can enter but never win)
    - Weighted odds by reputation tier
    """

    REPUTATION_WEIGHTS = {
        'exceptional': 1.5,   # 800-850
        'very_good': 1.25,    # 740-799
        'good': 1.1,          # 670-739
        'fair': 1.0,          # 580-669
        'poor': 0.75,         # 300-579
    }

    def __init__(self, dal, currency_service, reputation_api_url: str = None):
        self.dal = dal
        self.currency_service = currency_service
        self.reputation_api_url = reputation_api_url

    async def create_giveaway(
        self,
        community_id: int,
        title: str,
        prize_description: str,
        created_by: int,
        description: str = None,
        entry_cost: int = 0,
        max_entries_per_user: int = 1,
        reputation_floor: int = 450,
        weighted_by_reputation: bool = False,
        starts_at: datetime = None,
        ends_at: datetime = None
    ) -> Optional[int]:
        """Create a new giveaway."""
        try:
            query = """
                INSERT INTO loyalty_giveaways
                    (community_id, title, description, prize_description, entry_cost,
                     max_entries_per_user, reputation_floor, weighted_by_reputation,
                     status, starts_at, ends_at, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING id
            """
            result = await self.dal.execute(query, [
                community_id, title, description, prize_description, entry_cost,
                max_entries_per_user, reputation_floor, weighted_by_reputation,
                'draft', starts_at, ends_at, created_by
            ])
            return result[0]['id'] if result else None

        except Exception as e:
            logger.error(f"Error creating giveaway: {e}")
            return None

    async def get_active_giveaway(self, community_id: int) -> Optional[GiveawayInfo]:
        """Get the currently active giveaway for a community."""
        try:
            query = """
                SELECT g.*, COUNT(e.id) as entry_count
                FROM loyalty_giveaways g
                LEFT JOIN loyalty_giveaway_entries e ON g.id = e.giveaway_id
                WHERE g.community_id = $1 AND g.status = 'active'
                  AND (g.starts_at IS NULL OR g.starts_at <= NOW())
                  AND (g.ends_at IS NULL OR g.ends_at > NOW())
                GROUP BY g.id
                LIMIT 1
            """
            rows = await self.dal.execute(query, [community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return GiveawayInfo(
                    id=row['id'],
                    community_id=row['community_id'],
                    title=row['title'],
                    description=row['description'],
                    prize_description=row['prize_description'],
                    entry_cost=row['entry_cost'],
                    max_entries_per_user=row['max_entries_per_user'],
                    reputation_floor=row['reputation_floor'],
                    weighted_by_reputation=row['weighted_by_reputation'],
                    status=row['status'],
                    starts_at=row['starts_at'],
                    ends_at=row['ends_at'],
                    entry_count=row['entry_count']
                )
            return None

        except Exception as e:
            logger.error(f"Error getting active giveaway: {e}")
            return None

    async def _get_user_reputation(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> Dict[str, Any]:
        """Fetch user reputation from reputation module."""
        if not self.reputation_api_url:
            return {'score': 600, 'tier': 'fair'}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.reputation_api_url}/api/v1/reputation/{community_id}/user/{platform}/{platform_user_id}",
                    timeout=5.0
                )
                if response.status_code == 200:
                    data = response.json()
                    return {
                        'score': data.get('score', 600),
                        'tier': data.get('tier', 'fair')
                    }
        except Exception as e:
            logger.warning(f"Failed to fetch reputation: {e}")

        return {'score': 600, 'tier': 'fair'}

    def _get_reputation_tier(self, score: int) -> str:
        """Get reputation tier from score."""
        if score >= 800:
            return 'exceptional'
        elif score >= 740:
            return 'very_good'
        elif score >= 670:
            return 'good'
        elif score >= 580:
            return 'fair'
        return 'poor'

    async def enter_giveaway(
        self,
        giveaway_id: int,
        platform: str,
        platform_user_id: str,
        platform_username: str = None,
        hub_user_id: int = None
    ) -> Dict[str, Any]:
        """
        Enter a user into a giveaway.

        Returns dict with success status and message.
        Shadow-banned users (below reputation floor) can enter but are marked.
        """
        try:
            # Get giveaway
            query = "SELECT * FROM loyalty_giveaways WHERE id = $1"
            rows = await self.dal.execute(query, [giveaway_id])
            if not rows:
                return {'success': False, 'message': 'Giveaway not found'}

            giveaway = rows[0]

            if giveaway['status'] != 'active':
                return {'success': False, 'message': 'Giveaway is not active'}

            # Check existing entries
            entry_query = """
                SELECT entry_count FROM loyalty_giveaway_entries
                WHERE giveaway_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            existing = await self.dal.execute(entry_query, [giveaway_id, platform, platform_user_id])

            current_entries = existing[0]['entry_count'] if existing else 0
            if current_entries >= giveaway['max_entries_per_user']:
                return {'success': False, 'message': 'Maximum entries reached'}

            # Charge entry cost if applicable
            if giveaway['entry_cost'] > 0:
                result = await self.currency_service.remove_currency(
                    giveaway['community_id'], platform, platform_user_id,
                    giveaway['entry_cost'], 'giveaway_entry',
                    f"Entry for giveaway: {giveaway['title']}"
                )
                if not result.success:
                    return {'success': False, 'message': result.message}

            # Get reputation
            rep_data = await self._get_user_reputation(
                giveaway['community_id'], platform, platform_user_id
            )
            rep_score = rep_data['score']
            rep_tier = self._get_reputation_tier(rep_score)
            is_shadow_banned = rep_score < giveaway['reputation_floor']

            # Calculate weight multiplier
            weight = self.REPUTATION_WEIGHTS.get(rep_tier, 1.0) if giveaway['weighted_by_reputation'] else 1.0

            # Insert or update entry
            if existing:
                update_query = """
                    UPDATE loyalty_giveaway_entries
                    SET entry_count = entry_count + 1
                    WHERE giveaway_id = $1 AND platform = $2 AND platform_user_id = $3
                """
                await self.dal.execute(update_query, [giveaway_id, platform, platform_user_id])
            else:
                insert_query = """
                    INSERT INTO loyalty_giveaway_entries
                        (giveaway_id, hub_user_id, platform, platform_user_id, platform_username,
                         reputation_score, reputation_tier, is_shadow_banned, weight_multiplier)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """
                await self.dal.execute(insert_query, [
                    giveaway_id, hub_user_id, platform, platform_user_id, platform_username,
                    rep_score, rep_tier, is_shadow_banned, weight
                ])

            return {
                'success': True,
                'message': 'Entered successfully!' if not is_shadow_banned else 'Entered successfully!',
                'entries': current_entries + 1,
                'is_shadow_banned': is_shadow_banned  # Don't expose this to user
            }

        except Exception as e:
            logger.error(f"Error entering giveaway: {e}")
            return {'success': False, 'message': 'Failed to enter giveaway'}

    async def draw_winner(self, giveaway_id: int) -> Optional[Dict[str, Any]]:
        """
        Draw a winner using weighted random selection.
        Shadow-banned users are excluded from winning.
        """
        try:
            # Get eligible entries (not shadow banned)
            query = """
                SELECT * FROM loyalty_giveaway_entries
                WHERE giveaway_id = $1 AND is_shadow_banned = FALSE
            """
            entries = await self.dal.execute(query, [giveaway_id])

            if not entries:
                return None

            # Build weighted pool
            weighted_pool = []
            for entry in entries:
                weight = float(entry['weight_multiplier']) * entry['entry_count']
                weighted_pool.extend([entry] * int(weight * 100))

            if not weighted_pool:
                return None

            # Draw winner
            winner = random.choice(weighted_pool)

            # Update giveaway
            update_query = """
                UPDATE loyalty_giveaways
                SET status = 'completed',
                    winner_user_id = $1,
                    winner_platform = $2,
                    winner_platform_user_id = $3,
                    updated_at = NOW()
                WHERE id = $4
            """
            await self.dal.execute(update_query, [
                winner['hub_user_id'], winner['platform'],
                winner['platform_user_id'], giveaway_id
            ])

            logger.info(f"Giveaway {giveaway_id} winner: {winner['platform']}:{winner['platform_user_id']}")

            return {
                'platform': winner['platform'],
                'platform_user_id': winner['platform_user_id'],
                'platform_username': winner['platform_username']
            }

        except Exception as e:
            logger.error(f"Error drawing winner: {e}")
            return None

    async def list_giveaways(
        self,
        community_id: int,
        status: str = None,
        limit: int = 20
    ) -> List[Dict[str, Any]]:
        """List giveaways for a community."""
        try:
            if status:
                query = """
                    SELECT g.*, COUNT(e.id) as entry_count
                    FROM loyalty_giveaways g
                    LEFT JOIN loyalty_giveaway_entries e ON g.id = e.giveaway_id
                    WHERE g.community_id = $1 AND g.status = $2
                    GROUP BY g.id
                    ORDER BY g.created_at DESC
                    LIMIT $3
                """
                rows = await self.dal.execute(query, [community_id, status, limit])
            else:
                query = """
                    SELECT g.*, COUNT(e.id) as entry_count
                    FROM loyalty_giveaways g
                    LEFT JOIN loyalty_giveaway_entries e ON g.id = e.giveaway_id
                    WHERE g.community_id = $1
                    GROUP BY g.id
                    ORDER BY g.created_at DESC
                    LIMIT $2
                """
                rows = await self.dal.execute(query, [community_id, limit])

            return [dict(row) for row in (rows or [])]

        except Exception as e:
            logger.error(f"Error listing giveaways: {e}")
            return []
