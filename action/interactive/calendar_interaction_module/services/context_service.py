"""
Context Service - Multi-community context management for calendar module
Handles user session context switching between communities with Redis caching
and database fallback for entity-community relationships.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

# Redis session TTL: 24 hours
REDIS_SESSION_TTL = 86400


class ContextService:
    """
    Context service for managing user community context within entities.

    Features:
    - Redis-backed session context for fast lookups
    - Database fallback for default community resolution
    - Community availability validation
    - AAA (Auth/Authz/Audit) logging for context operations
    - Graceful fallback to DB-only mode when Redis unavailable
    """

    def __init__(self, dal, redis_client=None):
        """
        Initialize context service with database abstraction layer.

        Args:
            dal: AsyncDAL database abstraction layer
            redis_client: Optional Redis async client for session caching
        """
        self.dal = dal
        self.redis_client = redis_client

    async def get_current_context(
        self,
        user_id: int,
        entity_id: str
    ) -> Optional[int]:
        """
        Get active community ID for user in entity.

        Logic flow:
        1. Try to get from Redis session
        2. If found, return community_id
        3. If not in Redis, query DB for entity's default_community_id
        4. If no DB record, return None
        5. Store in Redis for future use (24h TTL)

        Args:
            user_id: Hub user ID
            entity_id: Entity identifier (e.g., discord:guild_id)

        Returns:
            Community ID (int) or None if not found

        AAA Logging: AUTH for access attempts
        """
        try:
            session_key = f"session_context:{user_id}:{entity_id}"

            # Step 1: Try Redis first (if available)
            if self.redis_client:
                try:
                    session_data = await self.redis_client.get(session_key)
                    if session_data:
                        context = json.loads(session_data)
                        community_id = context.get('current_community_id')
                        logger.debug(
                            f"[CONTEXT] Redis hit: user={user_id}, entity={entity_id}, "
                            f"community={community_id}"
                        )
                        return community_id
                except Exception as redis_err:
                    logger.warning(
                        f"[CONTEXT] Redis lookup failed: {redis_err}, falling back to DB"
                    )

            # Step 2-4: Query database for default community
            query = """
                SELECT default_community_id FROM entity_community_context
                WHERE entity_id = $1
                LIMIT 1
            """

            rows = await self.dal.execute(query, [entity_id])

            if not rows or len(rows) == 0:
                logger.debug(
                    f"[CONTEXT] No context found: user={user_id}, entity={entity_id}"
                )
                return None

            community_id = rows[0].get('default_community_id')

            if community_id is None:
                logger.debug(
                    f"[CONTEXT] Default community not set: user={user_id}, "
                    f"entity={entity_id}"
                )
                return None

            # Step 5: Cache in Redis for future use
            if self.redis_client:
                try:
                    context_data = {
                        'current_community_id': community_id,
                        'last_switched': datetime.now(timezone.utc).isoformat()
                    }
                    await self.redis_client.setex(
                        session_key,
                        REDIS_SESSION_TTL,
                        json.dumps(context_data)
                    )
                    logger.debug(
                        f"[CONTEXT] Cached in Redis: user={user_id}, "
                        f"entity={entity_id}, community={community_id}"
                    )
                except Exception as redis_err:
                    logger.warning(
                        f"[CONTEXT] Failed to cache in Redis: {redis_err}"
                    )

            return community_id

        except Exception as e:
            logger.error(
                f"[CONTEXT] ERROR: Failed to get current context for user={user_id}, "
                f"entity={entity_id}: {e}"
            )
            return None

    async def switch_context(
        self,
        user_id: int,
        entity_id: str,
        community_id: int
    ) -> bool:
        """
        Switch user's active community context within entity.

        Logic flow:
        1. Verify community exists in entity's available_communities (DB query)
        2. If valid, update Redis session with new community_id
        3. Set TTL to 24 hours
        4. Return True on success, False on failure

        Args:
            user_id: Hub user ID
            entity_id: Entity identifier
            community_id: Target community ID to switch to

        Returns:
            True on success, False on failure

        AAA Logging: AUDIT for context switches
        """
        try:
            # Step 1: Verify community exists in available communities
            query = """
                SELECT available_communities FROM entity_community_context
                WHERE entity_id = $1
                LIMIT 1
            """

            rows = await self.dal.execute(query, [entity_id])

            if not rows or len(rows) == 0:
                logger.warning(
                    f"[AUTHZ] DENIED: Entity context not found: entity={entity_id}"
                )
                return False

            available_communities = rows[0].get('available_communities', [])

            # Check if community_id is in available communities
            if community_id not in available_communities:
                logger.warning(
                    f"[AUTHZ] DENIED: Community {community_id} not available for "
                    f"entity={entity_id}. Available: {available_communities}"
                )
                return False

            # Step 2-3: Update Redis session with new community
            session_key = f"session_context:{user_id}:{entity_id}"

            if self.redis_client:
                try:
                    context_data = {
                        'current_community_id': community_id,
                        'last_switched': datetime.now(timezone.utc).isoformat()
                    }
                    await self.redis_client.setex(
                        session_key,
                        REDIS_SESSION_TTL,
                        json.dumps(context_data)
                    )

                    # Audit log
                    logger.info(
                        f"[AUDIT] Context switched: user={user_id}, entity={entity_id}, "
                        f"community={community_id}"
                    )

                    return True

                except Exception as redis_err:
                    logger.error(
                        f"[CONTEXT] ERROR: Failed to update Redis session: {redis_err}"
                    )
                    return False
            else:
                # DB-only mode: no session update possible
                logger.warning(
                    f"[CONTEXT] Redis unavailable: Cannot switch context for "
                    f"user={user_id}, entity={entity_id}"
                )
                return False

        except Exception as e:
            logger.error(
                f"[CONTEXT] ERROR: Context switch failed for user={user_id}, "
                f"entity={entity_id}, community={community_id}: {e}"
            )
            return False

    async def get_available_communities(
        self,
        entity_id: str
    ) -> List[int]:
        """
        Get list of communities that entity belongs to.

        Args:
            entity_id: Entity identifier

        Returns:
            List of community IDs the entity has access to (empty list if not found)
        """
        try:
            query = """
                SELECT available_communities FROM entity_community_context
                WHERE entity_id = $1
                LIMIT 1
            """

            rows = await self.dal.execute(query, [entity_id])

            if not rows or len(rows) == 0:
                logger.debug(
                    f"[CONTEXT] No available communities found: entity={entity_id}"
                )
                return []

            communities = rows[0].get('available_communities', [])
            logger.debug(
                f"[CONTEXT] Available communities: entity={entity_id}, "
                f"count={len(communities)}"
            )
            return communities

        except Exception as e:
            logger.error(
                f"[CONTEXT] ERROR: Failed to get available communities for "
                f"entity={entity_id}: {e}"
            )
            return []

    async def set_default_community(
        self,
        entity_id: str,
        community_id: int
    ) -> bool:
        """
        Set default community for entity (database update).

        Args:
            entity_id: Entity identifier
            community_id: Community ID to set as default

        Returns:
            True on success, False on failure

        AAA Logging: AUDIT for default community changes
        """
        try:
            # First verify community exists in available communities
            query = """
                SELECT available_communities FROM entity_community_context
                WHERE entity_id = $1
                LIMIT 1
            """

            rows = await self.dal.execute(query, [entity_id])

            if not rows or len(rows) == 0:
                logger.warning(
                    f"[AUTHZ] DENIED: Entity context not found: entity={entity_id}"
                )
                return False

            available_communities = rows[0].get('available_communities', [])

            if community_id not in available_communities:
                logger.warning(
                    f"[AUTHZ] DENIED: Community {community_id} not available for "
                    f"entity={entity_id}. Available: {available_communities}"
                )
                return False

            # Update default community
            update_query = """
                UPDATE entity_community_context
                SET default_community_id = $1, updated_at = NOW()
                WHERE entity_id = $2
                RETURNING default_community_id
            """

            result = await self.dal.execute(update_query, [community_id, entity_id])

            if not result or len(result) == 0:
                logger.error(
                    f"[AUDIT] FAILED: Default community update failed for entity={entity_id}"
                )
                return False

            logger.info(
                f"[AUDIT] Default community set: entity={entity_id}, "
                f"community={community_id}"
            )

            return True

        except Exception as e:
            logger.error(
                f"[CONTEXT] ERROR: Failed to set default community for "
                f"entity={entity_id}, community={community_id}: {e}"
            )
            return False

    async def get_context_with_fallback(
        self,
        user_id: int,
        entity_id: str
    ) -> Optional[int]:
        """
        Get context with automatic fallback to default.

        This is the most resilient method that:
        1. Tries to get user's current session context
        2. Falls back to entity's default community if needed
        3. Returns None only if neither exists

        Args:
            user_id: Hub user ID
            entity_id: Entity identifier

        Returns:
            Community ID (int) or None if neither session nor default exists

        AAA Logging: DEBUG for context resolution
        """
        try:
            # Try to get current context first
            current_context = await self.get_current_context(user_id, entity_id)

            if current_context is not None:
                logger.debug(
                    f"[CONTEXT] Using current context: user={user_id}, "
                    f"entity={entity_id}, community={current_context}"
                )
                return current_context

            # Fallback: get default community
            query = """
                SELECT default_community_id FROM entity_community_context
                WHERE entity_id = $1
                LIMIT 1
            """

            rows = await self.dal.execute(query, [entity_id])

            if not rows or len(rows) == 0:
                logger.debug(
                    f"[CONTEXT] No context or default available: user={user_id}, "
                    f"entity={entity_id}"
                )
                return None

            default_community_id = rows[0].get('default_community_id')

            if default_community_id:
                logger.debug(
                    f"[CONTEXT] Using default community: user={user_id}, "
                    f"entity={entity_id}, community={default_community_id}"
                )
                return default_community_id

            logger.debug(
                f"[CONTEXT] No default community set: user={user_id}, "
                f"entity={entity_id}"
            )
            return None

        except Exception as e:
            logger.error(
                f"[CONTEXT] ERROR: Failed to get context with fallback for "
                f"user={user_id}, entity={entity_id}: {e}"
            )
            return None
