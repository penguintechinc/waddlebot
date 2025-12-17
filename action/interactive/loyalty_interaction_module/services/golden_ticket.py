"""
Golden Ticket Service - RNG Lottery System for Loyalty Module
Exclusive chance to win big prizes through ticket purchases

Features:
- Buy lottery tickets with community currency
- Check owned tickets
- Admin drawing with random winner selection
- Configurable ticket price per community
- Prize pool accumulation
- Drawing history and winner announcements
- Automatic prize distribution to winner's balance
"""

import logging
import random
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Tuple
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class DrawingStatus(Enum):
    """Status of a drawing"""
    PENDING = "pending"
    DRAWN = "drawn"
    CROWNED = "crowned"


@dataclass
class TicketInfo:
    """Golden Ticket information"""
    id: int
    community_id: int
    user_id: int
    ticket_number: int
    round_id: int
    created_at: datetime
    won_at: Optional[datetime] = None
    is_crowned: bool = False
    crowned_at: Optional[datetime] = None


@dataclass
class RoundInfo:
    """Golden Ticket round information"""
    round_id: int
    community_id: int
    total_tickets: int
    total_pool_value: int
    winner_id: Optional[int] = None
    winner_username: Optional[str] = None
    winning_ticket_number: Optional[int] = None
    is_crowned: bool = False
    crowned_at: Optional[datetime] = None


@dataclass
class PurchaseResult:
    """Result of ticket purchase"""
    success: bool
    message: str
    tickets_purchased: int = 0
    total_cost: int = 0
    new_balance: int = 0
    ticket_numbers: List[int] = None


@dataclass
class DrawingResult:
    """Result of a drawing"""
    success: bool
    message: str
    round_id: Optional[int] = None
    winner_id: Optional[int] = None
    winner_username: Optional[str] = None
    winning_ticket_number: Optional[int] = None
    prize_pool: int = 0


class GoldenTicketService:
    """
    Golden Ticket lottery system for exclusive rewards.

    Features:
    - Configurable ticket price and odds per community
    - Round-based lottery system
    - Automatic prize pool accumulation
    - Random winner selection with auditable drawing
    - Winner announcement and balance distribution
    """

    def __init__(self, dal, currency_service):
        """
        Initialize Golden Ticket service.

        Args:
            dal: Database access layer
            currency_service: Currency service for balance operations
        """
        self.dal = dal
        self.currency_service = currency_service

    # =========================================================================
    # CONFIGURATION MANAGEMENT
    # =========================================================================

    async def get_or_create_config(
        self,
        community_id: int,
        ticket_price: int = 100,
        win_odds_denominator: int = 1000
    ) -> Dict[str, Any]:
        """
        Get or create Golden Ticket configuration for a community.

        Args:
            community_id: Community ID
            ticket_price: Cost of a ticket in currency
            win_odds_denominator: Odds denominator (1 in X chance)

        Returns:
            Configuration dictionary with current settings
        """
        try:
            # Check if config exists
            check_query = """
                SELECT id, community_id, is_enabled, ticket_price, win_odds_denominator,
                       current_round, round_started_at, created_at, updated_at
                FROM golden_ticket_config
                WHERE community_id = $1
            """
            rows = await self.dal.execute(check_query, [community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return {
                    'id': row['id'],
                    'community_id': row['community_id'],
                    'is_enabled': row['is_enabled'],
                    'ticket_price': row['ticket_price'],
                    'win_odds_denominator': row['win_odds_denominator'],
                    'current_round': row['current_round'],
                    'round_started_at': row['round_started_at'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at']
                }

            # Create new config
            insert_query = """
                INSERT INTO golden_ticket_config
                    (community_id, is_enabled, ticket_price, win_odds_denominator,
                     current_round, round_started_at)
                VALUES ($1, TRUE, $2, $3, 1, NOW())
                RETURNING id, community_id, is_enabled, ticket_price, win_odds_denominator,
                          current_round, round_started_at, created_at, updated_at
            """
            result = await self.dal.execute(
                insert_query,
                [community_id, ticket_price, win_odds_denominator]
            )

            if result:
                row = result[0]
                return {
                    'id': row['id'],
                    'community_id': row['community_id'],
                    'is_enabled': row['is_enabled'],
                    'ticket_price': row['ticket_price'],
                    'win_odds_denominator': row['win_odds_denominator'],
                    'current_round': row['current_round'],
                    'round_started_at': row['round_started_at'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at']
                }

            return None

        except Exception as e:
            logger.error(f"Error getting or creating Golden Ticket config: {e}")
            raise

    async def update_config(
        self,
        community_id: int,
        is_enabled: Optional[bool] = None,
        ticket_price: Optional[int] = None,
        win_odds_denominator: Optional[int] = None
    ) -> bool:
        """
        Update Golden Ticket configuration.

        Args:
            community_id: Community ID
            is_enabled: Enable/disable Golden Tickets
            ticket_price: New ticket price
            win_odds_denominator: New odds denominator

        Returns:
            True if successful
        """
        try:
            # Build dynamic update query
            updates = []
            params = []
            param_idx = 1

            if is_enabled is not None:
                updates.append(f"is_enabled = ${param_idx}")
                params.append(is_enabled)
                param_idx += 1

            if ticket_price is not None:
                if ticket_price <= 0:
                    logger.error("Ticket price must be positive")
                    return False
                updates.append(f"ticket_price = ${param_idx}")
                params.append(ticket_price)
                param_idx += 1

            if win_odds_denominator is not None:
                if win_odds_denominator <= 0:
                    logger.error("Win odds denominator must be positive")
                    return False
                updates.append(f"win_odds_denominator = ${param_idx}")
                params.append(win_odds_denominator)
                param_idx += 1

            if not updates:
                return True

            # Add community_id at the end
            params.append(community_id)

            update_query = f"""
                UPDATE golden_ticket_config
                SET {', '.join(updates)}, updated_at = NOW()
                WHERE community_id = ${param_idx}
            """

            await self.dal.execute(update_query, params)
            return True

        except Exception as e:
            logger.error(f"Error updating Golden Ticket config: {e}")
            return False

    # =========================================================================
    # TICKET PURCHASING
    # =========================================================================

    async def buy_tickets(
        self,
        community_id: int,
        user_id: int,
        platform: str,
        platform_user_id: str,
        count: int,
        hub_user_id: int = None
    ) -> PurchaseResult:
        """
        Purchase Golden Tickets for a user.

        Args:
            community_id: Community ID
            user_id: Hub user ID
            platform: Platform name (for currency)
            platform_user_id: Platform user ID (for currency)
            count: Number of tickets to purchase
            hub_user_id: Optional hub user ID if different from user_id

        Returns:
            PurchaseResult with success status and ticket numbers
        """
        try:
            # Validate count
            if count <= 0:
                return PurchaseResult(
                    success=False,
                    message="Must purchase at least 1 ticket"
                )

            if count > 100:  # Reasonable limit
                return PurchaseResult(
                    success=False,
                    message="Cannot purchase more than 100 tickets at once"
                )

            # Get configuration
            config = await self.get_or_create_config(community_id)
            if not config or not config['is_enabled']:
                return PurchaseResult(
                    success=False,
                    message="Golden Tickets are not enabled in this community"
                )

            ticket_price = config['ticket_price']
            total_cost = ticket_price * count
            current_round = config['current_round']

            # Check user balance
            balance_info = await self.currency_service.get_balance(
                community_id,
                platform,
                platform_user_id
            )

            if balance_info.balance < total_cost:
                return PurchaseResult(
                    success=False,
                    message=f"Insufficient balance. Need {total_cost}, have {balance_info.balance}"
                )

            # Deduct currency
            deduct_result = await self.currency_service.subtract_currency(
                community_id=community_id,
                platform=platform,
                platform_user_id=platform_user_id,
                amount=total_cost,
                transaction_type="golden_ticket_purchase",
                description=f"Purchased {count} Golden Tickets",
                hub_user_id=hub_user_id or user_id,
                reference_type="golden_ticket",
                reference_id=current_round
            )

            if not deduct_result.success:
                return PurchaseResult(
                    success=False,
                    message="Failed to process currency transaction"
                )

            # Generate ticket numbers
            existing_query = """
                SELECT COALESCE(MAX(ticket_number), 0) as max_ticket
                FROM golden_ticket_holders
                WHERE community_id = $1 AND round_id = $2
            """
            max_result = await self.dal.execute(
                existing_query,
                [community_id, current_round]
            )

            start_ticket_number = 1
            if max_result and len(max_result) > 0:
                start_ticket_number = max_result[0]['max_ticket'] + 1

            ticket_numbers = list(range(
                start_ticket_number,
                start_ticket_number + count
            ))

            # Insert tickets
            insert_query = """
                INSERT INTO golden_ticket_holders
                    (community_id, user_id, ticket_number, round_id, created_at)
                VALUES ($1, $2, $3, $4, NOW())
            """

            for ticket_num in ticket_numbers:
                await self.dal.execute(
                    insert_query,
                    [community_id, user_id, ticket_num, current_round]
                )

            logger.info(
                f"User {user_id} purchased {count} tickets in community {community_id} "
                f"for round {current_round}"
            )

            return PurchaseResult(
                success=True,
                message=f"Successfully purchased {count} Golden Tickets",
                tickets_purchased=count,
                total_cost=total_cost,
                new_balance=deduct_result.new_balance,
                ticket_numbers=ticket_numbers
            )

        except Exception as e:
            logger.error(f"Error buying tickets: {e}")
            return PurchaseResult(
                success=False,
                message="An error occurred while purchasing tickets"
            )

    # =========================================================================
    # TICKET CHECKING
    # =========================================================================

    async def get_user_tickets(
        self,
        community_id: int,
        user_id: int,
        round_id: Optional[int] = None
    ) -> List[TicketInfo]:
        """
        Get all tickets owned by a user.

        Args:
            community_id: Community ID
            user_id: User ID
            round_id: Optional specific round (if None, gets current round)

        Returns:
            List of TicketInfo objects
        """
        try:
            if round_id is None:
                # Get current round
                config_query = """
                    SELECT current_round FROM golden_ticket_config
                    WHERE community_id = $1
                """
                config_result = await self.dal.execute(config_query, [community_id])
                if config_result and len(config_result) > 0:
                    round_id = config_result[0]['current_round']
                else:
                    return []

            query = """
                SELECT id, community_id, user_id, ticket_number, round_id,
                       won_at, is_crowned, crowned_at, created_at
                FROM golden_ticket_holders
                WHERE community_id = $1 AND user_id = $2 AND round_id = $3
                ORDER BY ticket_number ASC
            """

            rows = await self.dal.execute(query, [community_id, user_id, round_id])

            tickets = []
            if rows:
                for row in rows:
                    tickets.append(TicketInfo(
                        id=row['id'],
                        community_id=row['community_id'],
                        user_id=row['user_id'],
                        ticket_number=row['ticket_number'],
                        round_id=row['round_id'],
                        created_at=row['created_at'],
                        won_at=row['won_at'],
                        is_crowned=row['is_crowned'],
                        crowned_at=row['crowned_at']
                    ))

            return tickets

        except Exception as e:
            logger.error(f"Error getting user tickets: {e}")
            return []

    async def get_round_info(
        self,
        community_id: int,
        round_id: Optional[int] = None
    ) -> Optional[RoundInfo]:
        """
        Get information about a Golden Ticket round.

        Args:
            community_id: Community ID
            round_id: Round ID (if None, gets current round)

        Returns:
            RoundInfo object or None
        """
        try:
            if round_id is None:
                # Get current round
                config_query = """
                    SELECT current_round FROM golden_ticket_config
                    WHERE community_id = $1
                """
                config_result = await self.dal.execute(config_query, [community_id])
                if config_result and len(config_result) > 0:
                    round_id = config_result[0]['current_round']
                else:
                    return None

            query = """
                SELECT
                    $1::INTEGER as round_id,
                    $1::INTEGER as community_id,
                    COUNT(*) as total_tickets,
                    COUNT(*) * gtc.ticket_price as total_pool_value,
                    MAX(CASE WHEN gth.won_at IS NOT NULL THEN gth.user_id END) as winner_id,
                    MAX(CASE WHEN gth.won_at IS NOT NULL THEN hu.username END) as winner_username,
                    MAX(CASE WHEN gth.won_at IS NOT NULL THEN gth.ticket_number END) as winning_ticket_number,
                    MAX(CASE WHEN gth.won_at IS NOT NULL THEN gth.is_crowned END) as is_crowned,
                    MAX(CASE WHEN gth.won_at IS NOT NULL THEN gth.crowned_at END) as crowned_at
                FROM golden_ticket_holders gth
                LEFT JOIN golden_ticket_config gtc ON gth.community_id = gtc.community_id
                LEFT JOIN hub_users hu ON gth.user_id = hu.id
                WHERE gth.community_id = $2 AND gth.round_id = $1
            """

            rows = await self.dal.execute(query, [round_id, community_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return RoundInfo(
                    round_id=round_id,
                    community_id=community_id,
                    total_tickets=row['total_tickets'],
                    total_pool_value=row['total_pool_value'] or 0,
                    winner_id=row['winner_id'],
                    winner_username=row['winner_username'],
                    winning_ticket_number=row['winning_ticket_number'],
                    is_crowned=row['is_crowned'] or False,
                    crowned_at=row['crowned_at']
                )

            return None

        except Exception as e:
            logger.error(f"Error getting round info: {e}")
            return None

    # =========================================================================
    # DRAWING MANAGEMENT
    # =========================================================================

    async def draw_winner(
        self,
        community_id: int,
        hub_user_id: int = None
    ) -> DrawingResult:
        """
        Draw a random winner from all tickets in the current round.

        Args:
            community_id: Community ID
            hub_user_id: Optional admin user ID for audit trail

        Returns:
            DrawingResult with winner information
        """
        try:
            # Get current round config
            config = await self.get_or_create_config(community_id)
            if not config:
                return DrawingResult(
                    success=False,
                    message="Golden Ticket system not configured"
                )

            current_round = config['current_round']

            # Get all tickets for this round (that haven't won yet)
            tickets_query = """
                SELECT id, user_id, ticket_number
                FROM golden_ticket_holders
                WHERE community_id = $1 AND round_id = $2 AND won_at IS NULL
                ORDER BY RANDOM()
                LIMIT 1
            """

            tickets_result = await self.dal.execute(
                tickets_query,
                [community_id, current_round]
            )

            if not tickets_result or len(tickets_result) == 0:
                return DrawingResult(
                    success=False,
                    message="No tickets available for drawing in this round",
                    round_id=current_round
                )

            winning_ticket = tickets_result[0]
            winner_id = winning_ticket['user_id']
            winning_ticket_id = winning_ticket['id']
            winning_ticket_number = winning_ticket['ticket_number']

            # Mark ticket as won
            update_query = """
                UPDATE golden_ticket_holders
                SET won_at = NOW()
                WHERE id = $1
                RETURNING user_id
            """

            await self.dal.execute(update_query, [winning_ticket_id])

            # Get winner info
            winner_query = """
                SELECT hu.id, hu.username
                FROM hub_users hu
                WHERE hu.id = $1
            """

            winner_result = await self.dal.execute(winner_query, [winner_id])
            winner_username = winner_result[0]['username'] if winner_result else "Unknown"

            # Calculate prize pool (all tickets sold * ticket price)
            pool_query = """
                SELECT COUNT(*) * $2 as pool_value
                FROM golden_ticket_holders
                WHERE community_id = $1 AND round_id = $3
            """

            pool_result = await self.dal.execute(
                pool_query,
                [community_id, config['ticket_price'], current_round]
            )

            prize_pool = pool_result[0]['pool_value'] if pool_result else 0

            logger.info(
                f"Golden Ticket drawing for community {community_id} round {current_round}: "
                f"Winner is user {winner_id} ({winner_username}) with ticket #{winning_ticket_number}. "
                f"Prize pool: {prize_pool}"
            )

            return DrawingResult(
                success=True,
                message=f"Winner drawn! {winner_username} wins with ticket #{winning_ticket_number}",
                round_id=current_round,
                winner_id=winner_id,
                winner_username=winner_username,
                winning_ticket_number=winning_ticket_number,
                prize_pool=prize_pool
            )

        except Exception as e:
            logger.error(f"Error during drawing: {e}")
            return DrawingResult(
                success=False,
                message="An error occurred during the drawing"
            )

    async def crown_winner(
        self,
        community_id: int,
        round_id: int,
        hub_user_id: int = None
    ) -> Dict[str, Any]:
        """
        Crown and announce the winner, distributing prize to their balance.

        Args:
            community_id: Community ID
            round_id: Round ID to crown
            hub_user_id: Optional admin user ID for audit trail

        Returns:
            Result dictionary with success status and winner info
        """
        try:
            # Get the winner for this round
            winner_query = """
                SELECT gth.id, gth.user_id, gth.ticket_number, gth.is_crowned,
                       hu.username, hu.platform_user_ids
                FROM golden_ticket_holders gth
                LEFT JOIN hub_users hu ON gth.user_id = hu.id
                WHERE gth.community_id = $1 AND gth.round_id = $2 AND gth.won_at IS NOT NULL
                LIMIT 1
            """

            winner_result = await self.dal.execute(
                winner_query,
                [community_id, round_id]
            )

            if not winner_result or len(winner_result) == 0:
                return {
                    'success': False,
                    'message': 'No winner found for this round'
                }

            winner_record = winner_result[0]
            winner_id = winner_record['user_id']
            winner_username = winner_record['username']
            ticket_holder_id = winner_record['id']

            if winner_record['is_crowned']:
                return {
                    'success': False,
                    'message': 'This winner has already been crowned'
                }

            # Calculate prize (all tickets in round * ticket price)
            prize_query = """
                SELECT COUNT(*) * gtc.ticket_price as prize_amount
                FROM golden_ticket_holders gth
                JOIN golden_ticket_config gtc ON gth.community_id = gtc.community_id
                WHERE gth.community_id = $1 AND gth.round_id = $2
            """

            prize_result = await self.dal.execute(
                prize_query,
                [community_id, round_id]
            )

            prize_amount = prize_result[0]['prize_amount'] if prize_result else 0

            # Get winner's platform info to credit balance
            # For now, assume primary platform user
            platform_user_ids = winner_record.get('platform_user_ids', {})

            # Try to find first platform mapping
            platform = None
            platform_user_id = None

            if isinstance(platform_user_ids, dict):
                for plat, user_id in platform_user_ids.items():
                    platform = plat
                    platform_user_id = user_id
                    break

            if not platform or not platform_user_id:
                return {
                    'success': False,
                    'message': 'Could not determine winner platform account'
                }

            # Add prize to winner's balance
            balance_result = await self.currency_service.add_currency(
                community_id=community_id,
                platform=platform,
                platform_user_id=platform_user_id,
                amount=prize_amount,
                transaction_type="golden_ticket_prize",
                description=f"Golden Ticket Prize - Round {round_id}",
                hub_user_id=winner_id,
                reference_type="golden_ticket_drawing",
                reference_id=round_id
            )

            if not balance_result.success:
                return {
                    'success': False,
                    'message': 'Failed to distribute prize to winner'
                }

            # Mark as crowned
            crown_query = """
                UPDATE golden_ticket_holders
                SET is_crowned = TRUE, crowned_at = NOW()
                WHERE id = $1
            """

            await self.dal.execute(crown_query, [ticket_holder_id])

            logger.info(
                f"Golden Ticket winner crowned for community {community_id} round {round_id}: "
                f"User {winner_id} ({winner_username}) received {prize_amount} currency"
            )

            return {
                'success': True,
                'message': f"Congratulations! {winner_username} has been crowned the winner!",
                'winner_id': winner_id,
                'winner_username': winner_username,
                'prize_amount': prize_amount,
                'new_balance': balance_result.new_balance,
                'round_id': round_id
            }

        except Exception as e:
            logger.error(f"Error crowning winner: {e}")
            return {
                'success': False,
                'message': 'An error occurred while crowning the winner'
            }

    # =========================================================================
    # ROUND MANAGEMENT
    # =========================================================================

    async def start_new_round(
        self,
        community_id: int
    ) -> Dict[str, Any]:
        """
        Start a new Golden Ticket round.

        Args:
            community_id: Community ID

        Returns:
            Result dictionary with new round info
        """
        try:
            # Get current config
            config = await self.get_or_create_config(community_id)
            if not config:
                return {
                    'success': False,
                    'message': 'Golden Ticket system not configured'
                }

            current_round = config['current_round']
            new_round = current_round + 1

            # Update config with new round
            update_query = """
                UPDATE golden_ticket_config
                SET current_round = $1, round_started_at = NOW()
                WHERE community_id = $2
            """

            await self.dal.execute(update_query, [new_round, community_id])

            logger.info(
                f"New Golden Ticket round started for community {community_id}: "
                f"Round {new_round}"
            )

            return {
                'success': True,
                'message': f'New round started: Round {new_round}',
                'previous_round': current_round,
                'new_round': new_round
            }

        except Exception as e:
            logger.error(f"Error starting new round: {e}")
            return {
                'success': False,
                'message': 'An error occurred while starting new round'
            }

    async def get_round_history(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[RoundInfo]:
        """
        Get history of completed Golden Ticket rounds.

        Args:
            community_id: Community ID
            limit: Maximum number of rounds to return

        Returns:
            List of RoundInfo objects for completed rounds
        """
        try:
            query = """
                SELECT DISTINCT gth.round_id
                FROM golden_ticket_holders gth
                WHERE gth.community_id = $1 AND gth.won_at IS NOT NULL
                ORDER BY gth.round_id DESC
                LIMIT $2
            """

            round_results = await self.dal.execute(
                query,
                [community_id, limit]
            )

            history = []
            if round_results:
                for round_row in round_results:
                    round_info = await self.get_round_info(
                        community_id,
                        round_row['round_id']
                    )
                    if round_info:
                        history.append(round_info)

            return history

        except Exception as e:
            logger.error(f"Error getting round history: {e}")
            return []

    # =========================================================================
    # ANALYTICS AND STATISTICS
    # =========================================================================

    async def get_user_statistics(
        self,
        community_id: int,
        user_id: int
    ) -> Dict[str, Any]:
        """
        Get Golden Ticket statistics for a user.

        Args:
            community_id: Community ID
            user_id: User ID

        Returns:
            Statistics dictionary
        """
        try:
            # Total tickets purchased
            total_query = """
                SELECT COUNT(*) as total_tickets
                FROM golden_ticket_holders
                WHERE community_id = $1 AND user_id = $2
            """

            total_result = await self.dal.execute(
                total_query,
                [community_id, user_id]
            )

            total_tickets = total_result[0]['total_tickets'] if total_result else 0

            # Wins
            wins_query = """
                SELECT COUNT(*) as wins
                FROM golden_ticket_holders
                WHERE community_id = $1 AND user_id = $2 AND won_at IS NOT NULL
            """

            wins_result = await self.dal.execute(
                wins_query,
                [community_id, user_id]
            )

            total_wins = wins_result[0]['wins'] if wins_result else 0

            # Total prizes won
            prizes_query = """
                SELECT COALESCE(SUM(gtc.ticket_price), 0) as total_prizes
                FROM golden_ticket_holders gth
                JOIN golden_ticket_config gtc ON gth.community_id = gtc.community_id
                WHERE gth.community_id = $1 AND gth.user_id = $2 AND gth.won_at IS NOT NULL
            """

            prizes_result = await self.dal.execute(
                prizes_query,
                [community_id, user_id]
            )

            total_prizes = prizes_result[0]['total_prizes'] if prizes_result else 0

            return {
                'total_tickets_purchased': total_tickets,
                'total_wins': total_wins,
                'total_prize_value': total_prizes,
                'win_rate': (total_wins / total_tickets * 100) if total_tickets > 0 else 0.0
            }

        except Exception as e:
            logger.error(f"Error getting user statistics: {e}")
            return {
                'total_tickets_purchased': 0,
                'total_wins': 0,
                'total_prize_value': 0,
                'win_rate': 0.0
            }

    async def get_leaderboard(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Get top Golden Ticket winners leaderboard.

        Args:
            community_id: Community ID
            limit: Maximum number of entries

        Returns:
            List of leaderboard entries with user and prize info
        """
        try:
            query = """
                SELECT
                    hu.id,
                    hu.username,
                    COUNT(DISTINCT gth.id) as wins,
                    SUM(gtc.ticket_price) as total_prize_value
                FROM golden_ticket_holders gth
                JOIN hub_users hu ON gth.user_id = hu.id
                JOIN golden_ticket_config gtc ON gth.community_id = gtc.community_id
                WHERE gth.community_id = $1 AND gth.won_at IS NOT NULL
                GROUP BY hu.id, hu.username
                ORDER BY total_prize_value DESC, wins DESC
                LIMIT $2
            """

            rows = await self.dal.execute(query, [community_id, limit])

            leaderboard = []
            if rows:
                for idx, row in enumerate(rows, 1):
                    leaderboard.append({
                        'rank': idx,
                        'user_id': row['id'],
                        'username': row['username'],
                        'wins': row['wins'],
                        'total_prize_value': row['total_prize_value']
                    })

            return leaderboard

        except Exception as e:
            logger.error(f"Error getting leaderboard: {e}")
            return []
