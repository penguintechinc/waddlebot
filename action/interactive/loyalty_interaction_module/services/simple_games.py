"""
Simple Games Service for Loyalty Module
Simple luck-based games: Dice, Rock-Paper-Scissors, Magic 8-Ball
"""
import logging
import random
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class GameResult:
    """Result of a simple game"""
    success: bool
    is_win: Optional[bool]  # None for non-wagered games
    game_type: str
    bet_amount: int
    win_amount: int
    new_balance: int
    result_data: Dict[str, Any]
    message: str
    cooldown_seconds: int = 0


class SimpleGamesService:
    """
    Simple luck-based games for the loyalty system.

    Games:
    1. Dice - Roll 1-6, win on 4-6 (1.5x payout)
    2. RPS - Rock-Paper-Scissors vs bot (2x payout on win)
    3. 8Ball - Magic 8-ball responses (no betting, just fun)
    """

    # Magic 8-Ball responses
    EIGHTBALL_RESPONSES = [
        # Positive responses
        "It is certain",
        "It is decidedly so",
        "Without a doubt",
        "Yes definitely",
        "You may rely on it",
        "As I see it, yes",
        "Most likely",
        "Outlook good",
        "Yes",
        "Signs point to yes",
        # Non-committal responses
        "Reply hazy, try again",
        "Ask again later",
        "Better not tell you now",
        "Cannot predict now",
        "Concentrate and ask again",
        # Negative responses
        "Don't count on it",
        "My reply is no",
        "My sources say no",
        "Outlook not so good",
        "Very doubtful",
    ]

    # RPS choices
    RPS_CHOICES = ['rock', 'paper', 'scissors']
    RPS_EMOJIS = {
        'rock': '🪨',
        'paper': '📄',
        'scissors': '✂️'
    }

    # Cooldown times in seconds
    COOLDOWN_DICE = 15
    COOLDOWN_RPS = 20
    COOLDOWN_EIGHTBALL = 10

    def __init__(self, dal, currency_service):
        """
        Initialize simple games service.

        Args:
            dal: Database access layer
            currency_service: Currency service for balance operations
        """
        self.dal = dal
        self.currency_service = currency_service

    async def _get_game_config(self, community_id: int, game_type: str) -> Dict[str, Any]:
        """
        Get game configuration for a community.

        Args:
            community_id: Community ID
            game_type: Type of game (dice, rps, eightball)

        Returns:
            Dictionary with game configuration
        """
        try:
            query = """
                SELECT simple_games_enabled,
                       dice_min_bet, dice_max_bet,
                       rps_min_bet, rps_max_bet
                FROM loyalty_config
                WHERE community_id = $1
            """
            rows = await self.dal.execute(query, [community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return {
                    'enabled': row['simple_games_enabled'],
                    'min_bet': row.get(f'{game_type}_min_bet', 10),
                    'max_bet': row.get(f'{game_type}_max_bet', 500)
                }

            # Defaults
            defaults = {
                'dice': {'min_bet': 10, 'max_bet': 500},
                'rps': {'min_bet': 10, 'max_bet': 500},
                'eightball': {'min_bet': 0, 'max_bet': 0}  # No betting
            }

            return {
                'enabled': True,
                'min_bet': defaults.get(game_type, {}).get('min_bet', 10),
                'max_bet': defaults.get(game_type, {}).get('max_bet', 500)
            }

        except Exception as e:
            logger.error(f"Error getting game config: {e}")
            return {'enabled': True, 'min_bet': 10, 'max_bet': 500}

    async def _check_cooldown(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        game_type: str
    ) -> Optional[int]:
        """
        Check if user has active cooldown for a game.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            game_type: Type of game

        Returns:
            Cooldown seconds remaining, or None if no cooldown
        """
        try:
            query = """
                SELECT cooldown_until
                FROM loyalty_simple_game_cooldowns
                WHERE community_id = $1 AND platform = $2
                  AND platform_user_id = $3 AND game_type = $4
                  AND cooldown_until > NOW()
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id, game_type])

            if rows and len(rows) > 0:
                cooldown_until = rows[0]['cooldown_until']
                now = datetime.utcnow()
                seconds_remaining = int((cooldown_until - now).total_seconds())
                return max(0, seconds_remaining)

            return None

        except Exception as e:
            logger.error(f"Error checking cooldown: {e}")
            return None

    async def _set_cooldown(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        game_type: str,
        cooldown_seconds: int
    ) -> None:
        """
        Set cooldown for a user on a game.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            game_type: Type of game
            cooldown_seconds: Cooldown duration in seconds
        """
        try:
            cooldown_until = datetime.utcnow() + timedelta(seconds=cooldown_seconds)

            query = """
                INSERT INTO loyalty_simple_game_cooldowns
                    (community_id, platform, platform_user_id, game_type, cooldown_until)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (community_id, platform, platform_user_id, game_type)
                DO UPDATE SET cooldown_until = $5
            """
            await self.dal.execute(query, [community_id, platform, platform_user_id, game_type, cooldown_until])

        except Exception as e:
            logger.error(f"Error setting cooldown: {e}")

    async def _record_game(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        game_type: str,
        bet_amount: int,
        win_amount: int,
        result_data: Dict[str, Any],
        is_win: Optional[bool],
        hub_user_id: int = None
    ) -> None:
        """
        Record game result in database.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            game_type: Type of game
            bet_amount: Amount wagered
            win_amount: Amount won
            result_data: Game-specific result data
            is_win: Whether user won (None for non-wagered games)
            hub_user_id: Optional hub user ID
        """
        try:
            query = """
                INSERT INTO loyalty_simple_game_results
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

    async def play_dice(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        bet_amount: int,
        hub_user_id: int = None
    ) -> GameResult:
        """
        Play dice game.

        Roll 1-6, win on 4-6 with 1.5x payout.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            bet_amount: Amount to wager
            hub_user_id: Optional hub user ID

        Returns:
            GameResult with outcome
        """
        # Check cooldown
        cooldown_remaining = await self._check_cooldown(community_id, platform, platform_user_id, 'dice')
        if cooldown_remaining is not None:
            return GameResult(
                success=False, is_win=False, game_type='dice',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message=f"You need to wait {cooldown_remaining}s before playing again",
                cooldown_seconds=cooldown_remaining
            )

        # Get config
        config = await self._get_game_config(community_id, 'dice')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=False, game_type='dice',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message="Dice is disabled in this community"
            )

        if bet_amount < config['min_bet'] or bet_amount > config['max_bet']:
            return GameResult(
                success=False, is_win=False, game_type='dice',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={},
                message=f"Bet must be between {config['min_bet']} and {config['max_bet']}"
            )

        # Deduct bet
        deduct_result = await self.currency_service.remove_currency(
            community_id, platform, platform_user_id, bet_amount,
            'game_dice', "Dice bet"
        )

        if not deduct_result.success:
            return GameResult(
                success=False, is_win=False, game_type='dice',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message=deduct_result.message
            )

        # Roll the dice
        roll = random.randint(1, 6)
        is_win = roll >= 4  # 4, 5, or 6
        multiplier = 1.5 if is_win else 0
        win_amount = int(bet_amount * multiplier)
        new_balance = deduct_result.new_balance

        # Award winnings
        if win_amount > 0:
            add_result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id, win_amount,
                'game_dice_win', f"Dice win: rolled {roll}"
            )
            new_balance = add_result.new_balance

        result_data = {
            'roll': roll,
            'multiplier': multiplier,
            'winning_roll': is_win
        }

        # Record game
        await self._record_game(
            community_id, platform, platform_user_id, 'dice',
            bet_amount, win_amount, result_data, is_win, hub_user_id
        )

        # Set cooldown
        await self._set_cooldown(community_id, platform, platform_user_id, 'dice', self.COOLDOWN_DICE)

        if is_win:
            message = f"🎲 You rolled {roll}! You won {win_amount}! (1.5x)"
        else:
            message = f"🎲 You rolled {roll}. Better luck next time!"

        return GameResult(
            success=True, is_win=is_win, game_type='dice',
            bet_amount=bet_amount, win_amount=win_amount, new_balance=new_balance,
            result_data=result_data, message=message,
            cooldown_seconds=self.COOLDOWN_DICE
        )

    async def play_rps(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        choice: str,
        bet_amount: int,
        hub_user_id: int = None
    ) -> GameResult:
        """
        Play Rock-Paper-Scissors vs bot.

        Win 2x your bet on win.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            choice: Player's choice (rock, paper, or scissors)
            bet_amount: Amount to wager
            hub_user_id: Optional hub user ID

        Returns:
            GameResult with outcome
        """
        # Check cooldown
        cooldown_remaining = await self._check_cooldown(community_id, platform, platform_user_id, 'rps')
        if cooldown_remaining is not None:
            return GameResult(
                success=False, is_win=False, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message=f"You need to wait {cooldown_remaining}s before playing again",
                cooldown_seconds=cooldown_remaining
            )

        # Get config
        config = await self._get_game_config(community_id, 'rps')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=False, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message="RPS is disabled in this community"
            )

        # Validate choice
        choice = choice.lower()
        if choice not in self.RPS_CHOICES:
            return GameResult(
                success=False, is_win=False, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={},
                message="Invalid choice. Use: rock, paper, or scissors"
            )

        if bet_amount < config['min_bet'] or bet_amount > config['max_bet']:
            return GameResult(
                success=False, is_win=False, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={},
                message=f"Bet must be between {config['min_bet']} and {config['max_bet']}"
            )

        # Deduct bet
        deduct_result = await self.currency_service.remove_currency(
            community_id, platform, platform_user_id, bet_amount,
            'game_rps', "RPS bet"
        )

        if not deduct_result.success:
            return GameResult(
                success=False, is_win=False, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=0,
                result_data={}, message=deduct_result.message
            )

        # Bot plays
        bot_choice = random.choice(self.RPS_CHOICES)

        # Determine winner
        is_win = False
        if choice == bot_choice:
            # Tie - refund bet
            await self.currency_service.add_currency(
                community_id, platform, platform_user_id, bet_amount,
                'game_rps_tie', "RPS tie - refund"
            )
            result_data = {
                'player_choice': choice,
                'bot_choice': bot_choice,
                'result': 'tie'
            }
            new_balance = deduct_result.new_balance
            message = f"{self.RPS_EMOJIS[choice]} vs {self.RPS_EMOJIS[bot_choice]} - It's a tie! Bet refunded."

            await self._record_game(
                community_id, platform, platform_user_id, 'rps',
                bet_amount, 0, result_data, None, hub_user_id
            )

            await self._set_cooldown(community_id, platform, platform_user_id, 'rps', self.COOLDOWN_RPS)

            return GameResult(
                success=True, is_win=None, game_type='rps',
                bet_amount=bet_amount, win_amount=0, new_balance=new_balance,
                result_data=result_data, message=message,
                cooldown_seconds=self.COOLDOWN_RPS
            )

        # Win conditions
        if (choice == 'rock' and bot_choice == 'scissors') or \
           (choice == 'paper' and bot_choice == 'rock') or \
           (choice == 'scissors' and bot_choice == 'paper'):
            is_win = True

        win_amount = bet_amount * 2 if is_win else 0
        new_balance = deduct_result.new_balance

        # Award winnings
        if win_amount > 0:
            add_result = await self.currency_service.add_currency(
                community_id, platform, platform_user_id, win_amount,
                'game_rps_win', f"RPS win: {choice} vs {bot_choice}"
            )
            new_balance = add_result.new_balance

        result_data = {
            'player_choice': choice,
            'bot_choice': bot_choice,
            'result': 'win' if is_win else 'loss'
        }

        # Record game
        await self._record_game(
            community_id, platform, platform_user_id, 'rps',
            bet_amount, win_amount, result_data, is_win, hub_user_id
        )

        # Set cooldown
        await self._set_cooldown(community_id, platform, platform_user_id, 'rps', self.COOLDOWN_RPS)

        if is_win:
            message = f"{self.RPS_EMOJIS[choice]} vs {self.RPS_EMOJIS[bot_choice]} - You win! Earned {win_amount}! (2x)"
        else:
            message = f"{self.RPS_EMOJIS[choice]} vs {self.RPS_EMOJIS[bot_choice]} - You lose. Better luck next time!"

        return GameResult(
            success=True, is_win=is_win, game_type='rps',
            bet_amount=bet_amount, win_amount=win_amount, new_balance=new_balance,
            result_data=result_data, message=message,
            cooldown_seconds=self.COOLDOWN_RPS
        )

    async def ask_eightball(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        question: str,
        hub_user_id: int = None
    ) -> GameResult:
        """
        Ask magic 8-ball a question.

        No betting, just fun. Always succeeds.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            question: The question to ask
            hub_user_id: Optional hub user ID

        Returns:
            GameResult with magic 8-ball response
        """
        # Check cooldown
        cooldown_remaining = await self._check_cooldown(community_id, platform, platform_user_id, 'eightball')
        if cooldown_remaining is not None:
            return GameResult(
                success=False, is_win=None, game_type='eightball',
                bet_amount=0, win_amount=0, new_balance=0,
                result_data={}, message=f"The 8-ball needs time to recover. Wait {cooldown_remaining}s",
                cooldown_seconds=cooldown_remaining
            )

        # Get config (eightball might have its own enable flag)
        config = await self._get_game_config(community_id, 'eightball')

        if not config['enabled']:
            return GameResult(
                success=False, is_win=None, game_type='eightball',
                bet_amount=0, win_amount=0, new_balance=0,
                result_data={}, message="Magic 8-Ball is disabled in this community"
            )

        # Ask the 8-ball
        response = random.choice(self.EIGHTBALL_RESPONSES)

        result_data = {
            'question': question,
            'response': response
        }

        # Record game (no wagering)
        await self._record_game(
            community_id, platform, platform_user_id, 'eightball',
            0, 0, result_data, None, hub_user_id
        )

        # Set cooldown
        await self._set_cooldown(community_id, platform, platform_user_id, 'eightball', self.COOLDOWN_EIGHTBALL)

        message = f"🎱 *shakes the 8-ball* ... {response}"

        return GameResult(
            success=True, is_win=None, game_type='eightball',
            bet_amount=0, win_amount=0, new_balance=0,
            result_data=result_data, message=message,
            cooldown_seconds=self.COOLDOWN_EIGHTBALL
        )

    async def get_game_stats(
        self,
        community_id: int,
        platform: str = None,
        platform_user_id: str = None,
        game_type: str = None
    ) -> Dict[str, Any]:
        """
        Get game statistics.

        Args:
            community_id: Community ID
            platform: Optional platform filter
            platform_user_id: Optional user ID filter
            game_type: Optional game type filter (dice, rps, eightball)

        Returns:
            Dictionary with game statistics by type
        """
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
                    SUM(CASE WHEN is_win = TRUE THEN 1 ELSE 0 END) as wins,
                    SUM(CASE WHEN is_win = FALSE THEN 1 ELSE 0 END) as losses,
                    SUM(bet_amount) as total_bet,
                    SUM(win_amount) as total_won
                FROM loyalty_simple_game_results
                WHERE {' AND '.join(conditions)}
                GROUP BY game_type
            """
            rows = await self.dal.execute(query, params)

            stats = {}
            for row in (rows or []):
                game = row['game_type']
                total_games = row['total_games']
                wins = row['wins'] or 0
                losses = row['losses'] or 0
                total_bet = row['total_bet'] or 0
                total_won = row['total_won'] or 0

                stats[game] = {
                    'total_games': total_games,
                    'wins': wins,
                    'losses': losses,
                    'win_rate': round(wins / total_games * 100, 2) if total_games > 0 else 0,
                    'total_bet': total_bet,
                    'total_won': total_won,
                    'net': total_won - total_bet
                }

            return stats

        except Exception as e:
            logger.error(f"Error getting game stats: {e}")
            return {}

    async def get_user_cooldowns(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> Dict[str, int]:
        """
        Get remaining cooldowns for a user across all games.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID

        Returns:
            Dictionary with game types and cooldown seconds remaining
        """
        try:
            query = """
                SELECT game_type, cooldown_until
                FROM loyalty_simple_game_cooldowns
                WHERE community_id = $1 AND platform = $2
                  AND platform_user_id = $3 AND cooldown_until > NOW()
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id])

            cooldowns = {}
            now = datetime.utcnow()

            for row in (rows or []):
                seconds_remaining = int((row['cooldown_until'] - now).total_seconds())
                if seconds_remaining > 0:
                    cooldowns[row['game_type']] = seconds_remaining

            return cooldowns

        except Exception as e:
            logger.error(f"Error getting cooldowns: {e}")
            return {}
