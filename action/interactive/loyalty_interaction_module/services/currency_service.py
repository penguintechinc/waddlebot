"""
Currency Service for Loyalty Module
Core currency operations: balance, transfers, adjustments
"""
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class BalanceInfo:
    """User balance information"""
    community_id: int
    platform: str
    platform_user_id: str
    balance: int
    lifetime_earned: int
    lifetime_spent: int


@dataclass
class TransactionResult:
    """Result of a currency transaction"""
    success: bool
    new_balance: int
    message: str
    transaction_id: Optional[int] = None


class CurrencyService:
    """
    Core currency operations for the loyalty system.

    Features:
    - Balance queries and leaderboards
    - Transfers between users
    - Admin adjustments
    - Full transaction audit trail
    """

    def __init__(self, dal):
        """
        Initialize currency service.

        Args:
            dal: Database access layer
        """
        self.dal = dal

    async def get_balance(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str
    ) -> BalanceInfo:
        """
        Get user's current balance.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID

        Returns:
            BalanceInfo with current balance and lifetime stats
        """
        try:
            query = """
                SELECT balance, lifetime_earned, lifetime_spent
                FROM loyalty_balances
                WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            rows = await self.dal.execute(query, [community_id, platform, platform_user_id])

            if rows and len(rows) > 0:
                row = rows[0]
                return BalanceInfo(
                    community_id=community_id,
                    platform=platform,
                    platform_user_id=platform_user_id,
                    balance=row['balance'],
                    lifetime_earned=row['lifetime_earned'],
                    lifetime_spent=row['lifetime_spent']
                )

            # Return zero balance if not found
            return BalanceInfo(
                community_id=community_id,
                platform=platform,
                platform_user_id=platform_user_id,
                balance=0,
                lifetime_earned=0,
                lifetime_spent=0
            )

        except Exception as e:
            logger.error(f"Error getting balance: {e}")
            raise

    async def add_currency(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        amount: int,
        transaction_type: str,
        description: str = None,
        hub_user_id: int = None,
        reference_type: str = None,
        reference_id: int = None
    ) -> TransactionResult:
        """
        Add currency to a user's balance.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            amount: Amount to add (must be positive)
            transaction_type: Type of transaction (earn_chat, earn_sub, etc.)
            description: Optional description
            hub_user_id: Optional hub user ID
            reference_type: Optional reference type
            reference_id: Optional reference ID

        Returns:
            TransactionResult with success status and new balance
        """
        if amount <= 0:
            return TransactionResult(
                success=False,
                new_balance=0,
                message="Amount must be positive"
            )

        try:
            # Get or create balance record
            balance_before = 0

            check_query = """
                SELECT id, balance FROM loyalty_balances
                WHERE community_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            rows = await self.dal.execute(check_query, [community_id, platform, platform_user_id])

            if rows and len(rows) > 0:
                balance_before = rows[0]['balance']
                # Update existing
                update_query = """
                    UPDATE loyalty_balances
                    SET balance = balance + $1,
                        lifetime_earned = lifetime_earned + $1,
                        updated_at = NOW()
                    WHERE community_id = $2 AND platform = $3 AND platform_user_id = $4
                    RETURNING balance
                """
                result = await self.dal.execute(update_query, [amount, community_id, platform, platform_user_id])
                new_balance = result[0]['balance']
            else:
                # Create new record
                insert_query = """
                    INSERT INTO loyalty_balances
                        (community_id, hub_user_id, platform, platform_user_id, balance, lifetime_earned)
                    VALUES ($1, $2, $3, $4, $5, $5)
                    RETURNING balance
                """
                result = await self.dal.execute(insert_query, [community_id, hub_user_id, platform, platform_user_id, amount])
                new_balance = result[0]['balance']

            # Record transaction
            tx_query = """
                INSERT INTO loyalty_transactions
                    (community_id, hub_user_id, platform, platform_user_id, transaction_type,
                     amount, balance_before, balance_after, description, reference_type, reference_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id
            """
            tx_result = await self.dal.execute(tx_query, [
                community_id, hub_user_id, platform, platform_user_id, transaction_type,
                amount, balance_before, new_balance, description, reference_type, reference_id
            ])

            logger.info(
                f"Added {amount} to {platform}:{platform_user_id} in community {community_id}. "
                f"New balance: {new_balance}"
            )

            return TransactionResult(
                success=True,
                new_balance=new_balance,
                message=f"Added {amount}. New balance: {new_balance}",
                transaction_id=tx_result[0]['id'] if tx_result else None
            )

        except Exception as e:
            logger.error(f"Error adding currency: {e}")
            return TransactionResult(
                success=False,
                new_balance=0,
                message=f"Error: {str(e)}"
            )

    async def remove_currency(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        amount: int,
        transaction_type: str,
        description: str = None,
        hub_user_id: int = None,
        allow_negative: bool = False
    ) -> TransactionResult:
        """
        Remove currency from a user's balance.

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            amount: Amount to remove (must be positive)
            transaction_type: Type of transaction
            description: Optional description
            hub_user_id: Optional hub user ID
            allow_negative: Allow balance to go negative (default False)

        Returns:
            TransactionResult with success status and new balance
        """
        if amount <= 0:
            return TransactionResult(
                success=False,
                new_balance=0,
                message="Amount must be positive"
            )

        try:
            # Get current balance
            balance_info = await self.get_balance(community_id, platform, platform_user_id)

            if not allow_negative and balance_info.balance < amount:
                return TransactionResult(
                    success=False,
                    new_balance=balance_info.balance,
                    message=f"Insufficient balance. Current: {balance_info.balance}, Required: {amount}"
                )

            # Update balance
            update_query = """
                UPDATE loyalty_balances
                SET balance = balance - $1,
                    lifetime_spent = lifetime_spent + $1,
                    updated_at = NOW()
                WHERE community_id = $2 AND platform = $3 AND platform_user_id = $4
                RETURNING balance
            """
            result = await self.dal.execute(update_query, [amount, community_id, platform, platform_user_id])
            new_balance = result[0]['balance'] if result else balance_info.balance - amount

            # Record transaction
            tx_query = """
                INSERT INTO loyalty_transactions
                    (community_id, hub_user_id, platform, platform_user_id, transaction_type,
                     amount, balance_before, balance_after, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
            """
            tx_result = await self.dal.execute(tx_query, [
                community_id, hub_user_id, platform, platform_user_id, transaction_type,
                -amount, balance_info.balance, new_balance, description
            ])

            return TransactionResult(
                success=True,
                new_balance=new_balance,
                message=f"Removed {amount}. New balance: {new_balance}",
                transaction_id=tx_result[0]['id'] if tx_result else None
            )

        except Exception as e:
            logger.error(f"Error removing currency: {e}")
            return TransactionResult(
                success=False,
                new_balance=0,
                message=f"Error: {str(e)}"
            )

    async def transfer(
        self,
        community_id: int,
        from_platform: str,
        from_user_id: str,
        to_platform: str,
        to_user_id: str,
        amount: int
    ) -> TransactionResult:
        """
        Transfer currency between users.

        Args:
            community_id: Community ID
            from_platform: Sender's platform
            from_user_id: Sender's platform user ID
            to_platform: Recipient's platform
            to_user_id: Recipient's platform user ID
            amount: Amount to transfer

        Returns:
            TransactionResult with success status
        """
        if amount <= 0:
            return TransactionResult(
                success=False,
                new_balance=0,
                message="Amount must be positive"
            )

        # Remove from sender
        remove_result = await self.remove_currency(
            community_id, from_platform, from_user_id, amount,
            'transfer_out', f"Transfer to {to_platform}:{to_user_id}"
        )

        if not remove_result.success:
            return remove_result

        # Add to recipient
        add_result = await self.add_currency(
            community_id, to_platform, to_user_id, amount,
            'transfer_in', f"Transfer from {from_platform}:{from_user_id}"
        )

        if not add_result.success:
            # Rollback sender's balance
            await self.add_currency(
                community_id, from_platform, from_user_id, amount,
                'transfer_refund', "Transfer failed - refund"
            )
            return add_result

        return TransactionResult(
            success=True,
            new_balance=remove_result.new_balance,
            message=f"Transferred {amount} to {to_platform}:{to_user_id}"
        )

    async def get_leaderboard(
        self,
        community_id: int,
        limit: int = 10,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Get top users by balance.

        Args:
            community_id: Community ID
            limit: Number of results
            offset: Offset for pagination

        Returns:
            List of user balance records
        """
        try:
            query = """
                SELECT lb.platform, lb.platform_user_id, lb.balance,
                       lb.lifetime_earned, lb.lifetime_spent,
                       hu.username as hub_username
                FROM loyalty_balances lb
                LEFT JOIN hub_users hu ON lb.hub_user_id = hu.id
                WHERE lb.community_id = $1
                ORDER BY lb.balance DESC
                LIMIT $2 OFFSET $3
            """
            rows = await self.dal.execute(query, [community_id, limit, offset])

            return [dict(row) for row in (rows or [])]

        except Exception as e:
            logger.error(f"Error getting leaderboard: {e}")
            return []

    async def set_balance(
        self,
        community_id: int,
        platform: str,
        platform_user_id: str,
        amount: int,
        admin_user_id: int,
        reason: str = None
    ) -> TransactionResult:
        """
        Set user's balance to exact amount (admin function).

        Args:
            community_id: Community ID
            platform: Platform name
            platform_user_id: Platform user ID
            amount: New balance amount
            admin_user_id: Admin performing the action
            reason: Reason for adjustment

        Returns:
            TransactionResult with success status
        """
        try:
            current = await self.get_balance(community_id, platform, platform_user_id)
            difference = amount - current.balance

            if difference == 0:
                return TransactionResult(
                    success=True,
                    new_balance=amount,
                    message="Balance unchanged"
                )

            # Update or create balance
            upsert_query = """
                INSERT INTO loyalty_balances
                    (community_id, platform, platform_user_id, balance)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (community_id, platform, platform_user_id)
                DO UPDATE SET balance = $4, updated_at = NOW()
                RETURNING balance
            """
            await self.dal.execute(upsert_query, [community_id, platform, platform_user_id, amount])

            # Record transaction
            tx_query = """
                INSERT INTO loyalty_transactions
                    (community_id, hub_user_id, platform, platform_user_id, transaction_type,
                     amount, balance_before, balance_after, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """
            await self.dal.execute(tx_query, [
                community_id, admin_user_id, platform, platform_user_id, 'admin_set',
                difference, current.balance, amount, reason or "Admin balance adjustment"
            ])

            logger.info(
                f"Admin {admin_user_id} set balance for {platform}:{platform_user_id} "
                f"from {current.balance} to {amount}"
            )

            return TransactionResult(
                success=True,
                new_balance=amount,
                message=f"Balance set to {amount}"
            )

        except Exception as e:
            logger.error(f"Error setting balance: {e}")
            return TransactionResult(
                success=False,
                new_balance=0,
                message=f"Error: {str(e)}"
            )

    async def wipe_community(
        self,
        community_id: int,
        admin_user_id: int
    ) -> bool:
        """
        Wipe all currency balances for a community (admin function).

        Args:
            community_id: Community ID
            admin_user_id: Admin performing the action

        Returns:
            True if successful
        """
        try:
            # Record wipe in transactions
            tx_query = """
                INSERT INTO loyalty_transactions
                    (community_id, hub_user_id, platform, platform_user_id, transaction_type,
                     amount, balance_before, balance_after, description)
                SELECT community_id, $2, platform, platform_user_id, 'admin_wipe',
                       -balance, balance, 0, 'Community currency wipe'
                FROM loyalty_balances
                WHERE community_id = $1 AND balance > 0
            """
            await self.dal.execute(tx_query, [community_id, admin_user_id])

            # Wipe balances
            wipe_query = """
                UPDATE loyalty_balances
                SET balance = 0, updated_at = NOW()
                WHERE community_id = $1
            """
            await self.dal.execute(wipe_query, [community_id])

            logger.warning(f"Admin {admin_user_id} wiped all currency for community {community_id}")

            return True

        except Exception as e:
            logger.error(f"Error wiping community currency: {e}")
            return False
