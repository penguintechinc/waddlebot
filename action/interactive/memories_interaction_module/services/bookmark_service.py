"""
Bookmark Service

Manages URL bookmarks with metadata, tags, and search.
"""

import logging
from typing import Dict, Any, List, Optional
from datetime import datetime
import aiohttp
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


class BookmarkService:
    """
    Service for managing URL bookmarks.

    Features:
    - Add/remove bookmarks
    - Auto-fetch URL metadata (title, description)
    - Tag-based organization
    - Full-text search
    - Visit tracking
    - Popular bookmarks
    """

    def __init__(self, dal):
        """
        Initialize bookmark service.

        Args:
            dal: Database access layer
        """
        self.dal = dal

    async def _fetch_url_metadata(self, url: str) -> Dict[str, str]:
        """
        Fetch title and description from URL.

        Args:
            url: URL to fetch

        Returns:
            Dictionary with title and description
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=10),
                    headers={'User-Agent': 'WaddleBot/1.0'}
                ) as response:
                    if response.status == 200:
                        html = await response.text()
                        soup = BeautifulSoup(html, 'html.parser')

                        # Get title
                        title = None
                        title_tag = soup.find('title')
                        if title_tag:
                            title = title_tag.get_text().strip()

                        # Get description
                        description = None
                        meta_desc = soup.find(
                            'meta',
                            attrs={'name': 'description'}
                        )
                        if not meta_desc:
                            meta_desc = soup.find(
                                'meta',
                                attrs={'property': 'og:description'}
                            )
                        if meta_desc:
                            description = meta_desc.get('content', '').strip()

                        return {
                            'title': title or url,
                            'description': description or ''
                        }

        except Exception as e:
            logger.warning(f"Failed to fetch URL metadata for {url}: {e}")

        return {'title': url, 'description': ''}

    async def add_bookmark(
        self,
        community_id: int,
        url: str,
        created_by_username: str,
        created_by_user_id: Optional[int] = None,
        title: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
        auto_fetch_metadata: bool = True
    ) -> Dict[str, Any]:
        """
        Add a new bookmark.

        Args:
            community_id: Community ID
            url: URL to bookmark
            created_by_username: Who added the bookmark
            created_by_user_id: User ID who added
            title: Optional title (auto-fetched if not provided)
            description: Optional description (auto-fetched if not provided)
            tags: List of tags
            auto_fetch_metadata: Auto-fetch title/description from URL

        Returns:
            Bookmark dictionary with ID
        """
        try:
            # Auto-fetch metadata if requested
            if auto_fetch_metadata and (not title or not description):
                metadata = await self._fetch_url_metadata(url)
                if not title:
                    title = metadata.get('title', url)
                if not description:
                    description = metadata.get('description', '')

            # Ensure title and description
            title = title or url
            description = description or ''
            tags = tags or []

            result = self.dal.executesql(
                """INSERT INTO memories_bookmarks
                   (community_id, url, title, description, tags,
                    created_by_username, created_by_user_id, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                [
                    community_id,
                    url,
                    title,
                    description,
                    tags,
                    created_by_username,
                    created_by_user_id,
                    datetime.utcnow(),
                    datetime.utcnow()
                ]
            )

            if result and result[0]:
                bookmark_id = result[0][0]
                logger.info(
                    f"Bookmark {bookmark_id} added by {created_by_username} "
                    f"in community {community_id}"
                )
                return {
                    'id': bookmark_id,
                    'url': url,
                    'title': title,
                    'description': description,
                    'tags': tags,
                    'visits': 0
                }

            raise Exception("Failed to insert bookmark")

        except Exception as e:
            logger.error(f"Failed to add bookmark: {e}")
            raise

    async def get_bookmark(
        self,
        community_id: int,
        bookmark_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get a specific bookmark by ID.

        Args:
            community_id: Community ID
            bookmark_id: Bookmark ID

        Returns:
            Bookmark dictionary or None
        """
        try:
            result = self.dal.executesql(
                """SELECT id, url, title, description, tags,
                          created_by_username, visits, created_at
                   FROM memories_bookmarks
                   WHERE id = %s AND community_id = %s""",
                [bookmark_id, community_id]
            )

            if result and result[0]:
                row = result[0]
                return {
                    'id': row[0],
                    'url': row[1],
                    'title': row[2],
                    'description': row[3],
                    'tags': row[4] or [],
                    'created_by_username': row[5],
                    'visits': row[6],
                    'created_at': row[7].isoformat() if row[7] else None
                }

            return None

        except Exception as e:
            logger.error(f"Failed to get bookmark: {e}")
            return None

    async def search_bookmarks(
        self,
        community_id: int,
        search_query: Optional[str] = None,
        tags: Optional[List[str]] = None,
        created_by: Optional[str] = None,
        limit: int = 50,
        offset: int = 0
    ) -> List[Dict[str, Any]]:
        """
        Search bookmarks with full-text search and filters.

        Args:
            community_id: Community ID
            search_query: Full-text search query
            tags: Filter by tags (any match)
            created_by: Filter by creator username
            limit: Maximum results
            offset: Pagination offset

        Returns:
            List of bookmark dictionaries
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

            # Tag filter (any match)
            if tags:
                conditions.append("tags && %s")
                params.append(tags)

            # Creator filter
            if created_by:
                conditions.append("created_by_username ILIKE %s")
                params.append(f"%{created_by}%")

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
                f"""SELECT id, url, title, description, tags,
                           created_by_username, visits, created_at
                    FROM memories_bookmarks
                    WHERE {where_clause}
                    {order_by}
                    LIMIT %s OFFSET %s""",
                params
            )

            return [
                {
                    'id': row[0],
                    'url': row[1],
                    'title': row[2],
                    'description': row[3],
                    'tags': row[4] or [],
                    'created_by_username': row[5],
                    'visits': row[6],
                    'created_at': row[7].isoformat() if row[7] else None
                }
                for row in result
            ]

        except Exception as e:
            logger.error(f"Failed to search bookmarks: {e}")
            return []

    async def delete_bookmark(
        self,
        community_id: int,
        bookmark_id: int,
        user_id: int
    ) -> bool:
        """
        Delete a bookmark.

        Args:
            community_id: Community ID
            bookmark_id: Bookmark ID to delete
            user_id: User requesting deletion (must be creator or admin)

        Returns:
            True if successful
        """
        try:
            # Check if user created this bookmark
            result = self.dal.executesql(
                """SELECT created_by_user_id FROM memories_bookmarks
                   WHERE id = %s AND community_id = %s""",
                [bookmark_id, community_id]
            )

            if not result or not result[0]:
                logger.warning(f"Bookmark {bookmark_id} not found")
                return False

            creator_id = result[0][0]
            if creator_id != user_id:
                logger.warning(
                    f"User {user_id} not authorized to delete bookmark "
                    f"{bookmark_id}"
                )
                return False

            # Delete bookmark
            self.dal.executesql(
                """DELETE FROM memories_bookmarks
                   WHERE id = %s AND community_id = %s""",
                [bookmark_id, community_id]
            )

            logger.info(f"Bookmark {bookmark_id} deleted by user {user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete bookmark: {e}")
            return False

    async def increment_visits(
        self,
        community_id: int,
        bookmark_id: int
    ) -> bool:
        """
        Increment visit count for bookmark.

        Args:
            community_id: Community ID
            bookmark_id: Bookmark ID

        Returns:
            True if successful
        """
        try:
            self.dal.executesql(
                """UPDATE memories_bookmarks
                   SET visits = visits + 1, updated_at = %s
                   WHERE id = %s AND community_id = %s""",
                [datetime.utcnow(), bookmark_id, community_id]
            )
            return True

        except Exception as e:
            logger.error(f"Failed to increment visits: {e}")
            return False

    async def get_popular_bookmarks(
        self,
        community_id: int,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Get most visited bookmarks.

        Args:
            community_id: Community ID
            limit: Maximum results

        Returns:
            List of popular bookmarks
        """
        try:
            result = self.dal.executesql(
                """SELECT id, url, title, description, tags,
                          created_by_username, visits, created_at
                   FROM memories_bookmarks
                   WHERE community_id = %s AND visits > 0
                   ORDER BY visits DESC, created_at DESC
                   LIMIT %s""",
                [community_id, limit]
            )

            return [
                {
                    'id': row[0],
                    'url': row[1],
                    'title': row[2],
                    'description': row[3],
                    'tags': row[4] or [],
                    'created_by_username': row[5],
                    'visits': row[6],
                    'created_at': row[7].isoformat() if row[7] else None
                }
                for row in result
            ]

        except Exception as e:
            logger.error(f"Failed to get popular bookmarks: {e}")
            return []

    async def get_all_tags(self, community_id: int) -> List[str]:
        """
        Get all tags used in community.

        Args:
            community_id: Community ID

        Returns:
            List of unique tags
        """
        try:
            result = self.dal.executesql(
                """SELECT DISTINCT unnest(tags) as tag
                   FROM memories_bookmarks
                   WHERE community_id = %s AND tags IS NOT NULL
                   ORDER BY tag""",
                [community_id]
            )

            return [row[0] for row in result if row[0]]

        except Exception as e:
            logger.error(f"Failed to get tags: {e}")
            return []

    async def get_stats(self, community_id: int) -> Dict[str, Any]:
        """
        Get bookmark statistics for community.

        Args:
            community_id: Community ID

        Returns:
            Statistics dictionary
        """
        try:
            result = self.dal.executesql(
                """SELECT
                       COUNT(*) as total_bookmarks,
                       COUNT(DISTINCT created_by_username) as contributors,
                       SUM(visits) as total_visits,
                       MAX(created_at) as latest_bookmark
                   FROM memories_bookmarks
                   WHERE community_id = %s""",
                [community_id]
            )

            if result and result[0]:
                row = result[0]
                return {
                    'total_bookmarks': row[0] or 0,
                    'contributors': row[1] or 0,
                    'total_visits': row[2] or 0,
                    'latest_bookmark': row[3].isoformat() if row[3] else None
                }

            return {
                'total_bookmarks': 0,
                'contributors': 0,
                'total_visits': 0,
                'latest_bookmark': None
            }

        except Exception as e:
            logger.error(f"Failed to get bookmark stats: {e}")
            return {
                'total_bookmarks': 0,
                'contributors': 0,
                'total_visits': 0,
                'latest_bookmark': None
            }
