"""
Gear Service for Loyalty Module
Manages gear items, user inventory, and stat bonuses
"""
import logging
import random
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class GearItem:
    """Gear item information"""
    id: int
    name: str
    display_name: str
    category: str
    item_type: str
    rarity: str
    attack_bonus: int
    defense_bonus: int
    luck_bonus: int
    cost: int
    emoji: str


@dataclass
class UserGearStats:
    """Aggregated user gear stats"""
    total_attack: int
    total_defense: int
    total_luck: int
    equipped_items: List[GearItem]


class GearService:
    """
    Gear management for duels and games.
    """

    RARITY_DROP_WEIGHTS = {
        'common': 100,
        'uncommon': 50,
        'rare': 20,
        'epic': 5,
        'legendary': 1
    }

    def __init__(self, dal, currency_service):
        self.dal = dal
        self.currency_service = currency_service

    async def get_shop_items(
        self,
        category: str = None,
        item_type: str = None
    ) -> List[GearItem]:
        """Get purchasable gear items."""
        try:
            conditions = ["is_purchasable = TRUE"]
            params = []
            idx = 1

            if category:
                conditions.append(f"gc.name = ${idx}")
                params.append(category)
                idx += 1

            if item_type:
                conditions.append(f"gi.item_type = ${idx}")
                params.append(item_type)

            query = f"""
                SELECT gi.*, gc.name as category_name, gc.display_name as category_display
                FROM loyalty_gear_items gi
                JOIN loyalty_gear_categories gc ON gi.category_id = gc.id
                WHERE {' AND '.join(conditions)}
                ORDER BY gi.rarity, gi.cost
            """
            rows = await self.dal.execute(query, params)

            return [
                GearItem(
                    id=row['id'],
                    name=row['name'],
                    display_name=row['display_name'],
                    category=row['category_name'],
                    item_type=row['item_type'],
                    rarity=row['rarity'],
                    attack_bonus=row['attack_bonus'],
                    defense_bonus=row['defense_bonus'],
                    luck_bonus=row['luck_bonus'],
                    cost=row['cost'],
                    emoji=row['emoji'] or '⚔️'
                )
                for row in (rows or [])
            ]

        except Exception as e:
            logger.error(f"Error getting shop items: {e}")
            return []

    async def get_user_inventory(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> List[Dict[str, Any]]:
        """Get user's gear inventory."""
        try:
            query = """
                SELECT ug.*, gi.name, gi.display_name, gi.item_type, gi.rarity,
                       gi.attack_bonus, gi.defense_bonus, gi.luck_bonus, gi.emoji,
                       gc.name as category_name
                FROM loyalty_user_gear ug
                JOIN loyalty_gear_items gi ON ug.gear_item_id = gi.id
                JOIN loyalty_gear_categories gc ON gi.category_id = gc.id
                WHERE ug.community_id = $1 AND ug.platform = $2 AND ug.platform_user_id = $3
                ORDER BY ug.is_equipped DESC, gi.rarity DESC
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id])
            return [dict(row) for row in (rows or [])]

        except Exception as e:
            logger.error(f"Error getting user inventory: {e}")
            return []

    async def get_equipped_stats(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> UserGearStats:
        """Get user's total stats from equipped gear."""
        try:
            query = """
                SELECT gi.*
                FROM loyalty_user_gear ug
                JOIN loyalty_gear_items gi ON ug.gear_item_id = gi.id
                WHERE ug.community_id = $1 AND ug.platform = $2
                  AND ug.platform_user_id = $3 AND ug.is_equipped = TRUE
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id])

            total_attack = 0
            total_defense = 0
            total_luck = 0
            equipped = []

            for row in (rows or []):
                total_attack += row['attack_bonus']
                total_defense += row['defense_bonus']
                total_luck += row['luck_bonus']
                equipped.append(GearItem(
                    id=row['id'], name=row['name'], display_name=row['display_name'],
                    category='', item_type=row['item_type'], rarity=row['rarity'],
                    attack_bonus=row['attack_bonus'], defense_bonus=row['defense_bonus'],
                    luck_bonus=row['luck_bonus'], cost=row['cost'], emoji=row['emoji'] or '⚔️'
                ))

            return UserGearStats(
                total_attack=total_attack,
                total_defense=total_defense,
                total_luck=total_luck,
                equipped_items=equipped
            )

        except Exception as e:
            logger.error(f"Error getting equipped stats: {e}")
            return UserGearStats(0, 0, 0, [])

    async def buy_item(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        item_id: int,
        hub_user_id: int = None
    ) -> Dict[str, Any]:
        """Purchase a gear item."""
        try:
            # Get item
            item_query = "SELECT * FROM loyalty_gear_items WHERE id = $1 AND is_purchasable = TRUE"
            items = await self.dal.execute(item_query, [item_id])

            if not items:
                return {'success': False, 'message': 'Item not found or not purchasable'}

            item = items[0]

            # Check if already owned
            owned_query = """
                SELECT id FROM loyalty_user_gear
                WHERE community_id = $1 AND platform = $2
                  AND platform_user_id = $3 AND gear_item_id = $4
            """
            owned = await self.dal.execute(owned_query, [community_id, platform, platform_user_id, item_id])

            if owned:
                return {'success': False, 'message': 'You already own this item'}

            # Charge currency
            result = await self.currency_service.remove_currency(
                community_id, platform, platform_user_id, item['cost'],
                'gear_purchase', f"Purchased {item['display_name']}"
            )

            if not result.success:
                return {'success': False, 'message': result.message}

            # Add to inventory
            insert_query = """
                INSERT INTO loyalty_user_gear
                    (community_id, hub_user_id, platform, platform_user_id, gear_item_id, acquired_via)
                VALUES ($1, $2, $3, $4, $5, 'purchase')
            """
            await self.dal.execute(insert_query, [community_id, hub_user_id, platform, platform_user_id, item_id])

            return {
                'success': True,
                'message': f"Purchased {item['emoji']} {item['display_name']}!",
                'item': dict(item)
            }

        except Exception as e:
            logger.error(f"Error buying item: {e}")
            return {'success': False, 'message': 'Failed to purchase item'}

    async def equip_item(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        item_id: int
    ) -> Dict[str, Any]:
        """Equip a gear item (unequips other items of same type)."""
        try:
            # Verify ownership
            owned_query = """
                SELECT ug.*, gi.item_type, gi.display_name
                FROM loyalty_user_gear ug
                JOIN loyalty_gear_items gi ON ug.gear_item_id = gi.id
                WHERE ug.community_id = $1 AND ug.platform = $2
                  AND ug.platform_user_id = $3 AND ug.gear_item_id = $4
            """
            owned = await self.dal.execute(owned_query, [community_id, platform, platform_user_id, item_id])

            if not owned:
                return {'success': False, 'message': 'You do not own this item'}

            item = owned[0]

            # Unequip other items of same type
            unequip_query = """
                UPDATE loyalty_user_gear ug
                SET is_equipped = FALSE
                FROM loyalty_gear_items gi
                WHERE ug.gear_item_id = gi.id
                  AND ug.community_id = $1 AND ug.platform = $2
                  AND ug.platform_user_id = $3 AND gi.item_type = $4
            """
            await self.dal.execute(unequip_query, [community_id, platform, platform_user_id, item['item_type']])

            # Equip the item
            equip_query = """
                UPDATE loyalty_user_gear
                SET is_equipped = TRUE
                WHERE community_id = $1 AND platform = $2
                  AND platform_user_id = $3 AND gear_item_id = $4
            """
            await self.dal.execute(equip_query, [community_id, platform, platform_user_id, item_id])

            return {
                'success': True,
                'message': f"Equipped {item['display_name']}!"
            }

        except Exception as e:
            logger.error(f"Error equipping item: {e}")
            return {'success': False, 'message': 'Failed to equip item'}

    async def drop_random_item(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        hub_user_id: int = None
    ) -> Optional[Dict[str, Any]]:
        """Drop a random gear item to user."""
        try:
            # Get droppable items with weights
            query = """
                SELECT gi.*, gc.name as category_name
                FROM loyalty_gear_items gi
                JOIN loyalty_gear_categories gc ON gi.category_id = gc.id
                WHERE gi.is_droppable = TRUE
            """
            items = await self.dal.execute(query, [])

            if not items:
                return None

            # Build weighted pool
            weighted_pool = []
            for item in items:
                weight = self.RARITY_DROP_WEIGHTS.get(item['rarity'], 10) * item['drop_weight']
                weighted_pool.extend([item] * weight)

            if not weighted_pool:
                return None

            # Pick random item
            dropped = random.choice(weighted_pool)

            # Check if already owned
            owned_query = """
                SELECT id FROM loyalty_user_gear
                WHERE community_id = $1 AND platform = $2
                  AND platform_user_id = $3 AND gear_item_id = $4
            """
            owned = await self.dal.execute(owned_query, [community_id, platform, platform_user_id, dropped['id']])

            if owned:
                # Already owned, give currency instead
                refund = dropped['cost'] // 2
                if refund > 0:
                    await self.currency_service.add_currency(
                        community_id, platform, platform_user_id, refund,
                        'gear_duplicate', f"Duplicate {dropped['display_name']} converted"
                    )
                return {
                    'item': dict(dropped),
                    'duplicate': True,
                    'refund': refund
                }

            # Add to inventory
            insert_query = """
                INSERT INTO loyalty_user_gear
                    (community_id, hub_user_id, platform, platform_user_id, gear_item_id, acquired_via)
                VALUES ($1, $2, $3, $4, $5, 'drop')
            """
            await self.dal.execute(insert_query, [community_id, hub_user_id, platform, platform_user_id, dropped['id']])

            return {
                'item': dict(dropped),
                'duplicate': False
            }

        except Exception as e:
            logger.error(f"Error dropping item: {e}")
            return None
