"""
Quote Service

Manages community quotes with full-text search, voting, and categorization.
"""

import logging
from typing import Dict, Any, List, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class QuoteService:
    """
    Service for managing community quotes.

    Features:
    - Add/remove quotes
    - Full-text search
    - Category filtering
    - Voting system (upvote/downvote)
    - Random quote selection
    - Quote statistics
    """

    def __init__(self, dal):
        """
        Initialize quote service.

        Args:
            dal: Database access layer
        """
        self.dal = dal

    async def add_quote(
        self,
        community_id: int,
        quote_text: str,
        created_by_username: str,
        created_by_user_id: Optional[int] = None,
        author_username: Optional[str] = None,
        author_user_id: Optional[int] = None,
        category: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Add a new quote.

        Args:
            community_id: Community ID
            quote_text: The quote text
            created_by_username: Who added the quote
            created_by_user_id: User ID who added the quote
            author_username: Quote author (if known)
            author_user_id: Author user ID (if known)
            category: Quote category

        Returns:
            Quote dictionary with ID
        """
        try:
            result = self.dal.executesql(
                """INSERT INTO memories_quotes
                   (community_id, quote_text, author_username, author_user_id,
                    created_by_username, created_by_user_id, category, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                [
                    community_id,
                    quote_text,
                    author_username,
                    author_user_id,
                    created_by_username,
                    created_by_user_id,
                    category,
                    datetime.utcnow(),
                    datetime.utcnow()
                ]
            )

            if result and result[0]:
                quote_id = result[0][0]
                logger.info(
                    f"Quote {quote_id} added by {created_by_username} "
                    f"in community {community_id}"
                )
                return {
                    'id': quote_id,
                    'quote_text': quote_text,
                    'author_username': author_username,
                    'category': category,
                    'votes': 0
                }

            raise Exception("Failed to insert quote")

        except Exception as e:
            logger.error(f"Failed to add quote: {e}")
            raise

    async def get_quote(
        self,
        community_id: int,
        quote_id: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get a specific quote by ID or random quote.

        Args:
            community_id: Community ID
            quote_id: Quote ID (if None, returns random)

        Returns:
            Quote dictionary or None
        """
        try:
            if quote_id:
                # Get specific quote
                result = self.dal.executesql(
                    """SELECT id, quote_text, author_username, author_user_id,
                              category, created_by_username, votes, created_at
                       FROM memories_quotes
                       WHERE id = %s AND community_id = %s""",
                    [quote_id, community_id]
                )
            else:
                # Get random quote
                result = self.dal.executesql(
                    """SELECT id, quote_text, author_username, author_user_id,
                              category, created_by_username, votes, created_at
                       FROM memories_quotes
                       WHERE community_id = %s
                       ORDER BY RANDOM()
                       LIMIT 1""",
                    [community_id]
                )

            if result and result[0]:
                row = result[0]
                return {
                    'id': row[0],
                    'quote_text': row[1],
                    'author_username': row[2],
                    'author_user_id': row[3],
                    'category': row[4],
                    'created_by_username': row[5],
                    'votes': row[6],
                    'created_at': row[7].isoformat() if row[7] else None
                }

            return None

        except Exception as e:
            logger.error(f"Failed to get quote: {e}")
            return None

    async def search_quotes(
        self,
        community_id: int,
        search_query: Optional[str] = None,
        category: Optional[str] = None,
        author: Optional[str] = None,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Search quotes with full-text search and filters.

        Args:
            community_id: Community ID
            search_query: Full-text search query
            category: Filter by category
            author: Filter by author username
            limit: Maximum results
            offset: Pagination offset

        Returns:
            List of quote dictionaries
        """
        try:
            conditions = ["community_id = %s"]
            params = [community_id]

            # Full-text search
            if search_query:
                conditions.append(
                    "search_vector @@ plainto_tsquery('english', %s)"
                )
                params.append(search_query)

            # Category filter
            if category:
                conditions.append("category = %s")
                params.append(category)

            # Author filter
            if author:
                conditions.append("author_username ILIKE %s")
                params.append(f"%{author}%")

            where_clause = " AND ".join(conditions)

            # Build ORDER BY clause
            if search_query:
                order_by = """
                    ORDER BY ts_rank(search_vector, plainto_tsquery('english', %s)) DESC,
                             created_at DESC
                """
                params.append(search_query)
            else:
                order_by = "ORDER BY created_at DESC"

            params.extend([limit, offset])

            result = self.dal.executesql(
                f"""SELECT id, quote_text, author_username, author_user_id,
                           category, created_by_username, votes, created_at
                    FROM memories_quotes
                    WHERE {where_clause}
                    {order_by}
                    LIMIT %s OFFSET %s""",
                params
            )

            return [
                {
                    'id': row[0],
                    'quote_text': row[1],
                    'author_username': row[2],
                    'author_user_id': row[3],
                    'category': row[4],
                    'created_by_username': row[5],
                    'votes': row[6],
                    'created_at': row[7].isoformat() if row[7] else None
                }
                for row in result
            ]

        except Exception as e:
            logger.error(f"Failed to search quotes: {e}")
            return []

    async def delete_quote(
        self,
        community_id: int,
        quote_id: int,
        user_id: int
    ) -> bool:
        """
        Delete a quote.

        Args:
            community_id: Community ID
            quote_id: Quote ID to delete
            user_id: User requesting deletion (must be creator or admin)

        Returns:
            True if successful
        """
        try:
            # Check if user created this quote
            result = self.dal.executesql(
                """SELECT created_by_user_id FROM memories_quotes
                   WHERE id = %s AND community_id = %s""",
                [quote_id, community_id]
            )

            if not result or not result[0]:
                logger.warning(f"Quote {quote_id} not found")
                return False

            creator_id = result[0][0]
            if creator_id != user_id:
                logger.warning(
                    f"User {user_id} not authorized to delete quote {quote_id}"
                )
                return False

            # Delete quote
            self.dal.executesql(
                """DELETE FROM memories_quotes
                   WHERE id = %s AND community_id = %s""",
                [quote_id, community_id]
            )

            logger.info(f"Quote {quote_id} deleted by user {user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete quote: {e}")
            return False

    async def vote_quote(
        self,
        community_id: int,
        quote_id: int,
        user_id: int,
        username: str,
        vote_type: str
    ) -> Dict[str, Any]:
        """
        Vote on a quote (upvote/downvote).

        Args:
            community_id: Community ID
            quote_id: Quote ID
            user_id: User voting
            username: Username voting
            vote_type: 'up' or 'down'

        Returns:
            Updated vote count
        """
        try:
            if vote_type not in ['up', 'down']:
                raise ValueError("vote_type must be 'up' or 'down'")

            # Check if quote exists
            result = self.dal.executesql(
                """SELECT id FROM memories_quotes
                   WHERE id = %s AND community_id = %s""",
                [quote_id, community_id]
            )

            if not result or not result[0]:
                raise ValueError(f"Quote {quote_id} not found")

            # Insert or update vote
            self.dal.executesql(
                """INSERT INTO memories_quote_votes
                   (quote_id, user_id, username, vote_type, created_at)
                   VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (quote_id, user_id)
                   DO UPDATE SET vote_type = EXCLUDED.vote_type""",
                [quote_id, user_id, username, vote_type, datetime.utcnow()]
            )

            # Recalculate vote count
            result = self.dal.executesql(
                """SELECT
                       COUNT(*) FILTER (WHERE vote_type = 'up') as upvotes,
                       COUNT(*) FILTER (WHERE vote_type = 'down') as downvotes
                   FROM memories_quote_votes
                   WHERE quote_id = %s""",
                [quote_id]
            )

            if result and result[0]:
                upvotes = result[0][0] or 0
                downvotes = result[0][1] or 0
                net_votes = upvotes - downvotes

                # Update quote votes
                self.dal.executesql(
                    """UPDATE memories_quotes
                       SET votes = %s, updated_at = %s
                       WHERE id = %s""",
                    [net_votes, datetime.utcnow(), quote_id]
                )

                return {
                    'quote_id': quote_id,
                    'votes': net_votes,
                    'upvotes': upvotes,
                    'downvotes': downvotes
                }

            raise Exception("Failed to calculate votes")

        except Exception as e:
            logger.error(f"Failed to vote on quote: {e}")
            raise

    async def get_categories(self, community_id: int) -> List[str]:
        """
        Get all categories used in community.

        Args:
            community_id: Community ID

        Returns:
            List of category names
        """
        try:
            result = self.dal.executesql(
                """SELECT DISTINCT category
                   FROM memories_quotes
                   WHERE community_id = %s AND category IS NOT NULL
                   ORDER BY category""",
                [community_id]
            )

            return [row[0] for row in result if row[0]]

        except Exception as e:
            logger.error(f"Failed to get categories: {e}")
            return []

    async def get_stats(self, community_id: int) -> Dict[str, Any]:
        """
        Get quote statistics for community.

        Args:
            community_id: Community ID

        Returns:
            Statistics dictionary
        """
        try:
            result = self.dal.executesql(
                """SELECT
                       COUNT(*) as total_quotes,
                       COUNT(DISTINCT author_username) as unique_authors,
                       COUNT(DISTINCT category) as categories,
                       MAX(created_at) as latest_quote,
                       AVG(votes) as avg_votes
                   FROM memories_quotes
                   WHERE community_id = %s""",
                [community_id]
            )

            if result and result[0]:
                row = result[0]
                return {
                    'total_quotes': row[0] or 0,
                    'unique_authors': row[1] or 0,
                    'categories': row[2] or 0,
                    'latest_quote': row[3].isoformat() if row[3] else None,
                    'avg_votes': float(row[4]) if row[4] else 0.0
                }

            return {
                'total_quotes': 0,
                'unique_authors': 0,
                'categories': 0,
                'latest_quote': None,
                'avg_votes': 0.0
            }

        except Exception as e:
            logger.error(f"Failed to get quote stats: {e}")
            return {
                'total_quotes': 0,
                'unique_authors': 0,
                'categories': 0,
                'latest_quote': None,
                'avg_votes': 0.0
            }
