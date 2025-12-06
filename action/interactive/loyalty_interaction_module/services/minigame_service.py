"""
Minigame Service for Loyalty Module
Slots, coinflip, roulette, and other gambling games
"""
import logging
import random
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class GameResult:
    """Result of a minigame"""
    success: bool
    is_win: bool
    bet_amount: int
    win_amount: int
    new_balance: int
    result_data: Dict[str, Any]
    message: str


class MinigameService:
    """
    Minigame service for slots, coinflip, roulette, etc.
    """

    # Slot machine symbols and payouts
    SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣']
    SLOT_PAYOUTS = {
        ('7️⃣', '7️⃣', '7️⃣'): 50,   # Jackpot
        ('💎', '💎', '💎'): 25,
        ('⭐', '⭐', '⭐'): 15,
        ('🍇', '🍇', '🍇'): 10,
        ('🍊', '🍊', '🍊'): 5,
        ('🍋', '🍋', '🍋'): 3,
        ('🍒', '🍒', '🍒'): 2,
    }

    # Roulette numbers
    ROULETTE_RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]
    ROULETTE_BLACK = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35]

    def __init__(self, dal, currency_service):
        self.dal = dal
        self.currency_service = currency_service

    async def _get_game_config(self, community_id: int, game_type: str) -> Dict[str, Any]:
        """Get game configuration for a community."""
        try:
            query = """
                SELECT minigames_enabled,
                       slots_min_bet, slots_max_bet,
                       coinflip_min_bet, coinflip_max_bet,
                       roulette_min_bet, roulette_max_bet
                FROM loyalty_config
                WHERE community_id = $1
            """
            rows = await self.dal.execute(query, [community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return {
                    'enabled': row['minigames_enabled'],
                    'min_bet': row.get(f'{game_type}_min_bet', 10),
                    'max_bet': row.get(f'{game_type}_max_bet', 1000)
                }

            return {'enabled': True, 'min_bet': 10, 'max_bet': 1000}

        except Exception as e:
            logger.error(f"Error getting game config: {e}")
            return {'enabled': True, 'min_bet': 10, 'max_bet': 1000}

    async def _record_game(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        game_type: str,
        bet_amount: int,
        win_amount: int,
        result_data: Dict[str, Any],
        is_win: bool,
        hub_user_id: int = None
    ) -> None:
        """Record game result in database."""
        try:
            query = """
                INSERT INTO loyalty_minigame_results
                    (community_id, hub_user_id, platform, platform_user_id,
                     game_type, bet_amount, win_amount, result_data, is_win)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """
            await self.dal.execute(query, [
                community_id, hub_user_id, platform, platform_user_id,
                game_type, bet_amount, win_amount, result_data, is_win
            ])
        except Exception as e:
            logger.error(f"Error recording game: {e}")

    async def play_slots(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        bet_amount: int,
        hub_user_id: int = None
    ) -> GameResult:
        """
        Play slot machine.

        Returns GameResult with spin outcome.
        """
        # Validate bet
        config = await self._get_game_config(community_id, 'slots')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message="Slots is disabled in this community"
            )

        if bet_amount < config['min_bet'] or bet_amount > config['max_bet']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=f"Bet must be between {config['min_bet']} and {config['max_bet']}"
            )

        # Deduct bet
        deduct_result = await self.currency_service.remove_currency(
            community_id, platform, platform_user_id, bet_amount,
            'gamble_slots', "Slots bet"
        )

        if not deduct_result.success:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=deduct_result.message
            )

        # Spin the reels
        reels = [random.choice(self.SLOT_SYMBOLS) for _ in range(3)]
        result_tuple = tuple(reels)

        # Calculate winnings
        multiplier = self.SLOT_PAYOUTS.get(result_tuple, 0)

        # Check for 2 matching symbols (small win)
        if multiplier == 0 and reels[0] == reels[1]:
            multiplier = 1.5

        win_amount = int(bet_amount * multiplier)
        is_win = win_amount > 0
        new_balance = deduct_result.new_balance

        # Award winnings
        if win_amount > 0:
            add_result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id, win_amount,
                'gamble_slots_win', f"Slots win: {' '.join(reels)}"
            )
            new_balance = add_result.new_balance

        result_data = {
            'reels': reels,
            'multiplier': multiplier
        }

        # Record game
        await self._record_game(
            community_id, platform, platform_user_id, 'slots',
            bet_amount, win_amount, result_data, is_win, hub_user_id
        )

        if is_win:
            message = f"🎰 {' '.join(reels)} - You won {win_amount}! ({multiplier}x)"
        else:
            message = f"🎰 {' '.join(reels)} - Better luck next time!"

        return GameResult(
            success=True, is_win=is_win, bet_amount=bet_amount,
            win_amount=win_amount, new_balance=new_balance,
            result_data=result_data, message=message
        )

    async def play_coinflip(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        bet_amount: int,
        choice: str = 'heads',
        hub_user_id: int = None
    ) -> GameResult:
        """
        Play coinflip - 50/50 double or nothing.
        """
        config = await self._get_game_config(community_id, 'coinflip')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message="Coinflip is disabled in this community"
            )

        if bet_amount < config['min_bet'] or bet_amount > config['max_bet']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=f"Bet must be between {config['min_bet']} and {config['max_bet']}"
            )

        choice = choice.lower()
        if choice not in ['heads', 'tails', 'h', 't']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message="Choose 'heads' or 'tails'"
            )

        choice = 'heads' if choice in ['heads', 'h'] else 'tails'

        # Deduct bet
        deduct_result = await self.currency_service.remove_currency(
            community_id, platform, platform_user_id, bet_amount,
            'gamble_coinflip', "Coinflip bet"
        )

        if not deduct_result.success:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=deduct_result.message
            )

        # Flip the coin
        result = random.choice(['heads', 'tails'])
        is_win = result == choice
        win_amount = bet_amount * 2 if is_win else 0
        new_balance = deduct_result.new_balance

        if is_win:
            add_result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id, win_amount,
                'gamble_coinflip_win', f"Coinflip win: {result}"
            )
            new_balance = add_result.new_balance

        result_data = {'choice': choice, 'result': result}
        emoji = '🪙' if result == 'heads' else '🌙'

        await self._record_game(
            community_id, platform, platform_user_id, 'coinflip',
            bet_amount, win_amount, result_data, is_win, hub_user_id
        )

        if is_win:
            message = f"{emoji} {result.upper()}! You won {win_amount}!"
        else:
            message = f"{emoji} {result.upper()}! You lose."

        return GameResult(
            success=True, is_win=is_win, bet_amount=bet_amount,
            win_amount=win_amount, new_balance=new_balance,
            result_data=result_data, message=message
        )

    async def play_roulette(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        bet_amount: int,
        bet_type: str,
        hub_user_id: int = None
    ) -> GameResult:
        """
        Play roulette.

        bet_type can be: red, black, even, odd, or a number (0-36)
        """
        config = await self._get_game_config(community_id, 'roulette')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message="Roulette is disabled"
            )

        if bet_amount < config['min_bet'] or bet_amount > config['max_bet']:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=f"Bet must be between {config['min_bet']} and {config['max_bet']}"
            )

        bet_type = bet_type.lower()

        # Validate bet type
        valid_bets = ['red', 'black', 'even', 'odd']
        is_number_bet = False
        bet_number = None

        try:
            bet_number = int(bet_type)
            if 0 <= bet_number <= 36:
                is_number_bet = True
            else:
                return GameResult(
                    success=False, is_win=False, bet_amount=bet_amount,
                    win_amount=0, new_balance=0, result_data={},
                    message="Number must be 0-36"
                )
        except ValueError:
            if bet_type not in valid_bets:
                return GameResult(
                    success=False, is_win=False, bet_amount=bet_amount,
                    win_amount=0, new_balance=0, result_data={},
                    message="Invalid bet. Use: red, black, even, odd, or 0-36"
                )

        # Deduct bet
        deduct_result = await self.currency_service.remove_currency(
            community_id, platform, platform_user_id, bet_amount,
            'gamble_roulette', f"Roulette bet: {bet_type}"
        )

        if not deduct_result.success:
            return GameResult(
                success=False, is_win=False, bet_amount=bet_amount,
                win_amount=0, new_balance=0, result_data={},
                message=deduct_result.message
            )

        # Spin the wheel
        result = random.randint(0, 36)
        is_red = result in self.ROULETTE_RED
        is_black = result in self.ROULETTE_BLACK
        is_even = result != 0 and result % 2 == 0
        is_odd = result % 2 == 1

        # Determine win
        is_win = False
        multiplier = 0

        if is_number_bet:
            is_win = result == bet_number
            multiplier = 35 if is_win else 0
        elif bet_type == 'red':
            is_win = is_red
            multiplier = 2 if is_win else 0
        elif bet_type == 'black':
            is_win = is_black
            multiplier = 2 if is_win else 0
        elif bet_type == 'even':
            is_win = is_even
            multiplier = 2 if is_win else 0
        elif bet_type == 'odd':
            is_win = is_odd
            multiplier = 2 if is_win else 0

        win_amount = bet_amount * multiplier
        new_balance = deduct_result.new_balance

        if win_amount > 0:
            add_result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id, win_amount,
                'gamble_roulette_win', f"Roulette win: {result}"
            )
            new_balance = add_result.new_balance

        color = '🔴' if is_red else ('⚫' if is_black else '🟢')
        result_data = {
            'bet_type': bet_type,
            'result': result,
            'color': 'red' if is_red else ('black' if is_black else 'green'),
            'multiplier': multiplier
        }

        await self._record_game(
            community_id, platform, platform_user_id, 'roulette',
            bet_amount, win_amount, result_data, is_win, hub_user_id
        )

        if is_win:
            message = f"🎡 {color} {result} - You won {win_amount}! ({multiplier}x)"
        else:
            message = f"🎡 {color} {result} - You lose."

        return GameResult(
            success=True, is_win=is_win, bet_amount=bet_amount,
            win_amount=win_amount, new_balance=new_balance,
            result_data=result_data, message=message
        )

    async def get_game_stats(
        self,
        community_id: int,
        platform: str = None,
        platform_user_id: str = None,
        game_type: str = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """Get game statistics."""
        try:
            conditions = ["community_id = $1"]
            params = [community_id]
            idx = 2

            if platform and platform_user_id:
                conditions.append(f"platform = ${idx} AND platform_user_id = ${idx + 1}")
                params.extend([platform, platform_user_id])
                idx += 2

            if game_type:
                conditions.append(f"game_type = ${idx}")
                params.append(game_type)
                idx += 1

            query = f"""
                SELECT
                    game_type,
                    COUNT(*) as total_games,
                    SUM(CASE WHEN is_win THEN 1 ELSE 0 END) as wins,
                    SUM(bet_amount) as total_bet,
                    SUM(win_amount) as total_won
                FROM loyalty_minigame_results
                WHERE {' AND '.join(conditions)}
                GROUP BY game_type
            """
            rows = await self.dal.execute(query, params)

            stats = {}
            for row in (rows or []):
                stats[row['game_type']] = {
                    'total_games': row['total_games'],
                    'wins': row['wins'],
                    'losses': row['total_games'] - row['wins'],
                    'win_rate': round(row['wins'] / row['total_games'] * 100, 2) if row['total_games'] > 0 else 0,
                    'total_bet': row['total_bet'],
                    'total_won': row['total_won'],
                    'net': row['total_won'] - row['total_bet']
                }

            return stats

        except Exception as e:
            logger.error(f"Error getting game stats: {e}")
            return {}
