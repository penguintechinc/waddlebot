"""
Earning Configuration Service
Manages per-community earning rates and processes activity events
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class EarningConfig:
    """Community earning configuration"""
    community_id: int
    currency_name: str
    currency_symbol: str
    earn_chat_message: int
    earn_chat_cooldown_seconds: int
    earn_watch_time_per_minute: int
    earn_follow: int
    earn_sub_tier1: int
    earn_sub_tier2: int
    earn_sub_tier3: int
    earn_gift_sub: int
    earn_raid_per_viewer: int
    earn_cheer_per_100bits: int
    earn_donation_per_dollar: int


class EarningConfigService:
    """
    Manages earning configuration and processes activity events.
    """

    def __init__(self, dal, currency_service):
        """
        Initialize earning config service.

        Args:
            dal: Database access layer
            currency_service: CurrencyService instance
        """
        self.dal = dal
        self.currency_service = currency_service

    async def get_config(self, community_id: int) -> EarningConfig:
        """Get earning configuration for a community."""
        try:
            query = """
                SELECT currency_name, currency_symbol,
                       earn_chat_message, earn_chat_cooldown_seconds,
                       earn_watch_time_per_minute, earn_follow,
                       earn_sub_tier1, earn_sub_tier2, earn_sub_tier3,
                       earn_gift_sub, earn_raid_per_viewer,
                       earn_cheer_per_100bits, earn_donation_per_dollar
                FROM loyalty_config
                WHERE community_id = $1
            """
            rows = await self.dal.execute(query, [community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return EarningConfig(
                    community_id=community_id,
                    currency_name=row['currency_name'],
                    currency_symbol=row['currency_symbol'],
                    earn_chat_message=row['earn_chat_message'],
                    earn_chat_cooldown_seconds=row['earn_chat_cooldown_seconds'],
                    earn_watch_time_per_minute=row['earn_watch_time_per_minute'],
                    earn_follow=row['earn_follow'],
                    earn_sub_tier1=row['earn_sub_tier1'],
                    earn_sub_tier2=row['earn_sub_tier2'],
                    earn_sub_tier3=row['earn_sub_tier3'],
                    earn_gift_sub=row['earn_gift_sub'],
                    earn_raid_per_viewer=row['earn_raid_per_viewer'],
                    earn_cheer_per_100bits=row['earn_cheer_per_100bits'],
                    earn_donation_per_dollar=row['earn_donation_per_dollar']
                )

            # Return defaults
            return EarningConfig(
                community_id=community_id,
                currency_name='Points',
                currency_symbol='🪙',
                earn_chat_message=1,
                earn_chat_cooldown_seconds=60,
                earn_watch_time_per_minute=2,
                earn_follow=50,
                earn_sub_tier1=500,
                earn_sub_tier2=1000,
                earn_sub_tier3=2500,
                earn_gift_sub=250,
                earn_raid_per_viewer=1,
                earn_cheer_per_100bits=10,
                earn_donation_per_dollar=10
            )

        except Exception as e:
            logger.error(f"Error getting earning config: {e}")
            raise

    async def update_config(self, community_id: int, updates: Dict[str, Any]) -> bool:
        """Update earning configuration."""
        try:
            # Build dynamic update
            fields = []
            values = []
            idx = 1

            allowed_fields = [
                'currency_name', 'currency_symbol', 'currency_emoji',
                'earn_chat_message', 'earn_chat_cooldown_seconds',
                'earn_watch_time_per_minute', 'earn_follow',
                'earn_sub_tier1', 'earn_sub_tier2', 'earn_sub_tier3',
                'earn_gift_sub', 'earn_raid_per_viewer',
                'earn_cheer_per_100bits', 'earn_donation_per_dollar'
            ]

            for field in allowed_fields:
                if field in updates:
                    fields.append(f"{field} = ${idx}")
                    values.append(updates[field])
                    idx += 1

            if not fields:
                return True

            fields.append("updated_at = NOW()")
            values.append(community_id)

            query = f"""
                INSERT INTO loyalty_config (community_id)
                VALUES (${idx})
                ON CONFLICT (community_id) DO UPDATE
                SET {', '.join(fields)}
            """
            await self.dal.execute(query, values)
            return True

        except Exception as e:
            logger.error(f"Error updating earning config: {e}")
            return False

    async def process_chat_message(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> Optional[int]:
        """
        Process chat message for earning (with cooldown check).

        Returns amount earned or None if on cooldown.
        """
        try:
            config = await self.get_config(community_id)

            if config.earn_chat_message <= 0:
                return None

            # Check cooldown
            cooldown_query = """
                SELECT last_chat_earn FROM loyalty_balances
                WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            rows = await self.dal.execute(cooldown_query, [community_id, platform, platform_user_id])

            if rows and rows[0]['last_chat_earn']:
                last_earn = rows[0]['last_chat_earn']
                cooldown_end = last_earn + timedelta(seconds=config.earn_chat_cooldown_seconds)
                if datetime.utcnow() < cooldown_end:
                    return None  # Still on cooldown

            # Award currency
            result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id,
                config.earn_chat_message, 'earn_chat', 'Chat message earning'
            )

            if result.success:
                # Update last earn time
                update_query = """
                    UPDATE loyalty_balances
                    SET last_chat_earn = NOW()
                    WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
                """
                await self.dal.execute(update_query, [community_id, platform, platform_user_id])
                return config.earn_chat_message

            return None

        except Exception as e:
            logger.error(f"Error processing chat message earning: {e}")
            return None

    async def process_event(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        event_type: str,
        metadata: Dict[str, Any] = None
    ) -> Optional[int]:
        """
        Process various events for earning.

        Args:
            event_type: follow, subscription, gift_sub, raid, cheer, donation
            metadata: Event-specific data (tier, viewers, bits, amount)
        """
        try:
            config = await self.get_config(community_id)
            metadata = metadata or {}
            amount = 0
            description = event_type

            if event_type == 'follow':
                amount = config.earn_follow
            elif event_type == 'subscription':
                tier = metadata.get('tier', 1)
                if tier == 1:
                    amount = config.earn_sub_tier1
                elif tier == 2:
                    amount = config.earn_sub_tier2
                elif tier == 3:
                    amount = config.earn_sub_tier3
                description = f"Tier {tier} subscription"
            elif event_type == 'gift_sub':
                count = metadata.get('count', 1)
                amount = config.earn_gift_sub * count
                description = f"Gifted {count} sub(s)"
            elif event_type == 'raid':
                viewers = metadata.get('viewers', 0)
                amount = config.earn_raid_per_viewer * viewers
                description = f"Raid with {viewers} viewers"
            elif event_type == 'cheer':
                bits = metadata.get('bits', 0)
                amount = (bits // 100) * config.earn_cheer_per_100bits
                description = f"Cheered {bits} bits"
            elif event_type == 'donation':
                dollars = metadata.get('amount', 0)
                amount = int(dollars * config.earn_donation_per_dollar)
                description = f"Donated ${dollars}"

            if amount > 0:
                result = await self.currency_service.add_currency(
                    community_id, platform, platform_user_id,
                    amount, f'earn_{event_type}', description
                )
                return amount if result.success else None

            return None

        except Exception as e:
            logger.error(f"Error processing event earning: {e}")
            return None
