"""
Duel Service for Loyalty Module
1v1 wager-based combat with gear bonuses
"""
import logging
import random
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class DuelResult:
    """Result of a duel"""
    success: bool
    message: str
    winner_platform: str = None
    winner_user_id: str = None
    loser_platform: str = None
    loser_user_id: str = None
    wager_amount: int = 0
    challenger_roll: int = 0
    defender_roll: int = 0


class DuelService:
    """
    Duel system with wagers and gear bonuses.
    """

    def __init__(self, dal, currency_service, gear_service):
        self.dal = dal
        self.currency_service = currency_service
        self.gear_service = gear_service
        self.duel_timeout_minutes = 5

    async def create_challenge(
        self,
        community_id: int,
        challenger_platform: str,
        challenger_user_id: str,
        wager_amount: int,
        defender_platform: str = None,
        defender_user_id: str = None,
        is_open: bool = False,
        hub_user_id: int = None
    ) -> Dict[str, Any]:
        """
        Create a duel challenge.

        If defender is None and is_open=True, anyone can accept.
        """
        if wager_amount <= 0:
            return {'success': False, 'message': 'Wager must be positive'}

        # Check challenger balance
        balance = await self.currency_service.get_balance(
            community_id, challenger_platform, challenger_user_id
        )

        if balance.balance < wager_amount:
            return {'success': False, 'message': f'Insufficient balance. You have {balance.balance}'}

        # Check for existing pending duel
        pending_query = """
            SELECT id FROM loyalty_duels
            WHERE community_id = $1 AND challenger_platform = $2
              AND challenger_platform_user_id = $3 AND status = 'pending'
        """
        pending = await self.dal.execute(pending_query, [community_id, challenger_platform, challenger_user_id])

        if pending:
            return {'success': False, 'message': 'You already have a pending duel'}

        # Hold the wager
        hold_result = await self.currency_service.remove_currency(
            community_id, challenger_platform, challenger_user_id, wager_amount,
            'duel_wager_hold', "Duel wager held"
        )

        if not hold_result.success:
            return {'success': False, 'message': hold_result.message}

        # Create duel
        expires_at = datetime.utcnow() + timedelta(minutes=self.duel_timeout_minutes)

        insert_query = """
            INSERT INTO loyalty_duels
                (community_id, challenger_user_id, challenger_platform, challenger_platform_user_id,
                 defender_platform, defender_platform_user_id, wager_amount, is_open_challenge, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        """
        result = await self.dal.execute(insert_query, [
            community_id, hub_user_id, challenger_platform, challenger_user_id,
            defender_platform, defender_user_id, wager_amount, is_open, expires_at
        ])

        duel_id = result[0]['id'] if result else None

        if is_open:
            message = f"Open duel challenge created for {wager_amount}! Anyone can !duel accept"
        elif defender_user_id:
            message = f"Duel challenge sent to {defender_platform}:{defender_user_id} for {wager_amount}!"
        else:
            message = f"Duel challenge created for {wager_amount}!"

        return {
            'success': True,
            'duel_id': duel_id,
            'message': message,
            'expires_at': expires_at.isoformat()
        }

    async def accept_duel(
        self,
        community_id: int,
        defender_platform: str,
        defender_user_id: str,
        duel_id: int = None,
        hub_user_id: int = None
    ) -> DuelResult:
        """Accept a duel challenge and resolve it."""
        try:
            # Find duel to accept
            if duel_id:
                query = """
                    SELECT * FROM loyalty_duels
                    WHERE id = $1 AND community_id = $2 AND status = 'pending'
                      AND expires_at > NOW()
                """
                params = [duel_id, community_id]
            else:
                # Find open challenge or direct challenge
                query = """
                    SELECT * FROM loyalty_duels
                    WHERE community_id = $1 AND status = 'pending' AND expires_at > NOW()
                      AND (is_open_challenge = TRUE
                           OR (defender_platform = $2 AND defender_platform_user_id = $3))
                    ORDER BY created_at DESC
                    LIMIT 1
                """
                params = [community_id, defender_platform, defender_user_id]

            duels = await self.dal.execute(query, params)

            if not duels:
                return DuelResult(success=False, message="No pending duel found")

            duel = duels[0]

            # Can't duel yourself
            if (duel['challenger_platform'] == defender_platform and
                duel['challenger_platform_user_id'] == defender_user_id):
                return DuelResult(success=False, message="You can't duel yourself")

            # Check defender balance
            balance = await self.currency_service.get_balance(
                community_id, defender_platform, defender_user_id
            )

            if balance.balance < duel['wager_amount']:
                return DuelResult(
                    success=False,
                    message=f"Insufficient balance. You need {duel['wager_amount']}"
                )

            # Hold defender's wager
            hold_result = await self.currency_service.remove_currency(
                community_id, defender_platform, defender_user_id, duel['wager_amount'],
                'duel_wager_hold', "Duel wager held"
            )

            if not hold_result.success:
                return DuelResult(success=False, message=hold_result.message)

            # Get gear bonuses
            challenger_stats = await self.gear_service.get_equipped_stats(
                community_id, duel['challenger_platform'], duel['challenger_platform_user_id']
            )
            defender_stats = await self.gear_service.get_equipped_stats(
                community_id, defender_platform, defender_user_id
            )

            # Roll for each player (1-100 + attack bonus + luck bonus)
            challenger_roll = random.randint(1, 100) + challenger_stats.total_attack + challenger_stats.total_luck
            defender_roll = random.randint(1, 100) + defender_stats.total_attack + defender_stats.total_luck

            # Determine winner
            if challenger_roll > defender_roll:
                winner_platform = duel['challenger_platform']
                winner_user_id = duel['challenger_platform_user_id']
                loser_platform = defender_platform
                loser_user_id = defender_user_id
            elif defender_roll > challenger_roll:
                winner_platform = defender_platform
                winner_user_id = defender_user_id
                loser_platform = duel['challenger_platform']
                loser_user_id = duel['challenger_platform_user_id']
            else:
                # Tie - refund both
                await self.currency_service.add_currency(
                    community_id, duel['challenger_platform'], duel['challenger_platform_user_id'],
                    duel['wager_amount'], 'duel_refund', "Duel tie refund"
                )
                await self.currency_service.add_currency(
                    community_id, defender_platform, defender_user_id,
                    duel['wager_amount'], 'duel_refund', "Duel tie refund"
                )

                # Update duel status
                await self.dal.execute(
                    "UPDATE loyalty_duels SET status = 'tie', resolved_at = NOW() WHERE id = $1",
                    [duel['id']]
                )

                return DuelResult(
                    success=True,
                    message=f"It's a tie! ({challenger_roll} vs {defender_roll}) Both wagers refunded.",
                    challenger_roll=challenger_roll,
                    defender_roll=defender_roll
                )

            # Award winner (both wagers)
            total_winnings = duel['wager_amount'] * 2
            await self.currency_service.add_currency(
                community_id, winner_platform, winner_user_id,
                total_winnings, 'duel_win', f"Won duel against {loser_platform}:{loser_user_id}"
            )

            # Update duel record
            update_query = """
                UPDATE loyalty_duels
                SET status = 'completed',
                    defender_platform = $1,
                    defender_platform_user_id = $2,
                    defender_user_id = $3,
                    winner_user_id = $4,
                    challenger_roll = $5,
                    defender_roll = $6,
                    challenger_gear_bonus = $7,
                    defender_gear_bonus = $8,
                    resolved_at = NOW()
                WHERE id = $9
            """
            await self.dal.execute(update_query, [
                defender_platform, defender_user_id, hub_user_id,
                duel['challenger_user_id'] if winner_platform == duel['challenger_platform'] else hub_user_id,
                challenger_roll, defender_roll,
                challenger_stats.total_attack + challenger_stats.total_luck,
                defender_stats.total_attack + defender_stats.total_luck,
                duel['id']
            ])

            # Update duel stats for both players
            await self._update_duel_stats(
                community_id, winner_platform, winner_user_id, True, duel['wager_amount']
            )
            await self._update_duel_stats(
                community_id, loser_platform, loser_user_id, False, duel['wager_amount']
            )

            return DuelResult(
                success=True,
                message=f"⚔️ {winner_platform}:{winner_user_id} wins! ({challenger_roll} vs {defender_roll}) Won {total_winnings}!",
                winner_platform=winner_platform,
                winner_user_id=winner_user_id,
                loser_platform=loser_platform,
                loser_user_id=loser_user_id,
                wager_amount=total_winnings,
                challenger_roll=challenger_roll,
                defender_roll=defender_roll
            )

        except Exception as e:
            logger.error(f"Error accepting duel: {e}")
            return DuelResult(success=False, message="Failed to process duel")

    async def _update_duel_stats(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        is_win: bool,
        wager_amount: int
    ) -> None:
        """Update duel statistics for a user."""
        try:
            query = """
                INSERT INTO loyalty_duel_stats
                    (community_id, platform, platform_user_id, total_duels, wins, losses,
                     total_wagered, total_won, total_lost, win_streak, best_win_streak)
                VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $9)
                ON CONFLICT (community_id, platform, platform_user_id)
                DO UPDATE SET
                    total_duels = loyalty_duel_stats.total_duels + 1,
                    wins = loyalty_duel_stats.wins + $4,
                    losses = loyalty_duel_stats.losses + $5,
                    total_wagered = loyalty_duel_stats.total_wagered + $6,
                    total_won = loyalty_duel_stats.total_won + $7,
                    total_lost = loyalty_duel_stats.total_lost + $8,
                    win_streak = CASE WHEN $4 = 1 THEN loyalty_duel_stats.win_streak + 1 ELSE 0 END,
                    best_win_streak = GREATEST(
                        loyalty_duel_stats.best_win_streak,
                        CASE WHEN $4 = 1 THEN loyalty_duel_stats.win_streak + 1 ELSE 0 END
                    ),
                    updated_at = NOW()
            """
            win_val = 1 if is_win else 0
            loss_val = 0 if is_win else 1
            won_amount = wager_amount * 2 if is_win else 0
            lost_amount = 0 if is_win else wager_amount
            streak_val = 1 if is_win else 0

            await self.dal.execute(query, [
                community_id, platform, platform_user_id,
                win_val, loss_val, wager_amount, won_amount, lost_amount, streak_val
            ])

        except Exception as e:
            logger.error(f"Error updating duel stats: {e}")

    async def get_duel_stats(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get duel statistics for a user."""
        try:
            query = """
                SELECT * FROM loyalty_duel_stats
                WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id])

            if rows:
                row = rows[0]
                win_rate = (row['wins'] / row['total_duels'] * 100) if row['total_duels'] > 0 else 0
                return {
                    'total_duels': row['total_duels'],
                    'wins': row['wins'],
                    'losses': row['losses'],
                    'win_rate': round(win_rate, 1),
                    'total_wagered': row['total_wagered'],
                    'total_won': row['total_won'],
                    'total_lost': row['total_lost'],
                    'net': row['total_won'] - row['total_lost'],
                    'win_streak': row['win_streak'],
                    'best_win_streak': row['best_win_streak']
                }

            return None

        except Exception as e:
            logger.error(f"Error getting duel stats: {e}")
            return None

    async def get_duel_leaderboard(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """Get duel leaderboard by wins."""
        try:
            query = """
                SELECT platform, platform_user_id, wins, losses, total_wagered,
                       total_won, best_win_streak
                FROM loyalty_duel_stats
                WHERE community_id = $1
                ORDER BY wins DESC, best_win_streak DESC
                LIMIT $2
            """
            rows = await self.dal.execute(query, [community_id, limit])
            return [dict(row) for row in (rows or [])]

        except Exception as e:
            logger.error(f"Error getting duel leaderboard: {e}")
            return []

    async def cancel_expired_duels(self, community_id: int = None) -> int:
        """Cancel expired duels and refund wagers."""
        try:
            if community_id:
                query = """
                    SELECT * FROM loyalty_duels
                    WHERE community_id = $1 AND status = 'pending' AND expires_at < NOW()
                """
                params = [community_id]
            else:
                query = """
                    SELECT * FROM loyalty_duels
                    WHERE status = 'pending' AND expires_at < NOW()
                """
                params = []

            expired = await self.dal.execute(query, params)
            count = 0

            for duel in (expired or []):
                # Refund challenger
                await self.currency_service.add_currency(
                    duel['community_id'], duel['challenger_platform'],
                    duel['challenger_platform_user_id'], duel['wager_amount'],
                    'duel_expired_refund', "Duel expired - refund"
                )

                # Update status
                await self.dal.execute(
                    "UPDATE loyalty_duels SET status = 'expired' WHERE id = $1",
                    [duel['id']]
                )
                count += 1

            return count

        except Exception as e:
            logger.error(f"Error canceling expired duels: {e}")
            return 0
