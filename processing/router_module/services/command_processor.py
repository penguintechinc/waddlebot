"""Command Processor - Async command routing and execution"""
import asyncio
import logging
from typing import Any, Dict, List

import aiohttp

from config import Config

logger = logging.getLogger(__name__)


class CommandProcessor:
    def __init__(self, dal, cache_manager, rate_limiter, session_manager):
        self.dal = dal
        self.cache = cache_manager
        self.rate_limiter = rate_limiter
        self.session_manager = session_manager
        self._http_session = None

    async def _get_http_session(self):
        """Get or create HTTP session for activity tracking"""
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=5)
            )
        return self._http_session

    async def process_event(self, event_data: Dict[str, Any]) -> Dict[str, Any]:
        """Process single event with async command routing"""
        try:
            entity_id = event_data.get('entity_id')
            user_id = event_data.get('user_id')
            message = event_data.get('message', '')
            message_type = event_data.get('message_type', 'chatMessage')
            metadata = event_data.get('metadata', {})

            # Generate session ID
            session_id = await self.session_manager.create_session(entity_id, user_id)

            # Handle slash commands (Discord /command, Slack /waddlebot)
            if message_type == 'slashCommand':
                return await self._process_slash_command(
                    event_data, entity_id, user_id, session_id, metadata
                )

            # Handle interactions (button clicks, modal submits, select menus)
            if message_type in ('interaction', 'modal_submit', 'button_click', 'select_menu'):
                return await self._process_interaction(
                    event_data, entity_id, user_id, session_id, metadata
                )

            # Handle stream events (no command response, just activity tracking)
            if message_type in ('stream_online', 'stream_offline', 'subscription',
                                'gift_subscription', 'follow', 'raid', 'cheer'):
                asyncio.create_task(self._record_stream_activity(event_data))
                return {"success": True, "session_id": session_id, "processed": True}

            # Record message activity for leaderboards (fire-and-forget)
            if message_type == 'chatMessage':
                asyncio.create_task(self._record_message_activity(event_data))

            # Check for prefix commands (! or #)
            if message.startswith('!') or message.startswith('#'):
                command = message.split()[0] if message else ''

                # Check rate limit
                if not await self.rate_limiter.check_rate_limit(f"{user_id}:{command}", limit=60):
                    return {"success": False, "error": "Rate limit exceeded"}

                # Execute command
                result = await self.execute_command(command, entity_id, user_id, message, session_id)
                return result

            return {"success": True, "session_id": session_id, "processed": False}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _process_slash_command(
        self,
        event_data: Dict[str, Any],
        entity_id: str,
        user_id: str,
        session_id: str,
        metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Process slash command from Discord or Slack"""
        command_name = metadata.get('command_name', '')
        options = metadata.get('options', {})
        platform = event_data.get('platform', 'unknown')

        # Build command string from slash command (e.g., /help -> !help)
        # This allows reusing existing command routing
        command = f"!{command_name}"

        # Build message from options
        args_str = ' '.join(str(v) for v in options.values()) if options else ''
        message = f"{command} {args_str}".strip()

        # Check rate limit
        if not await self.rate_limiter.check_rate_limit(f"{user_id}:{command}", limit=60):
            return {"success": False, "error": "Rate limit exceeded"}

        # Execute as regular command
        result = await self.execute_command(
            command, entity_id, user_id, message, session_id
        )

        # Add interaction metadata for deferred responses
        result['interaction_id'] = metadata.get('interaction_id')
        result['interaction_token'] = metadata.get('interaction_token')
        result['platform'] = platform

        return result

    async def _process_interaction(
        self,
        event_data: Dict[str, Any],
        entity_id: str,
        user_id: str,
        session_id: str,
        metadata: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Process button click, modal submit, or select menu"""
        interaction_type = event_data.get('message_type')
        custom_id = metadata.get('custom_id', '')
        values = metadata.get('values', {})
        platform = event_data.get('platform', 'unknown')

        # Parse custom_id to determine action
        # Format: module:action:context (e.g., "inventory:buy:item_123")
        parts = custom_id.split(':')
        module = parts[0] if parts else ''
        action = parts[1] if len(parts) > 1 else ''
        context = ':'.join(parts[2:]) if len(parts) > 2 else ''

        logger.info(f"Processing interaction: {interaction_type} - {custom_id}")

        # Route to appropriate module based on custom_id
        return {
            "success": True,
            "session_id": session_id,
            "interaction_type": interaction_type,
            "module": module,
            "action": action,
            "context": context,
            "values": values,
            "interaction_id": metadata.get('interaction_id'),
            "interaction_token": metadata.get('interaction_token'),
            "platform": platform
        }

    async def _record_stream_activity(self, event_data: Dict[str, Any]):
        """Record stream events (subs, follows, raids, etc.) for activity tracking"""
        try:
            if not Config.HUB_API_URL or not Config.SERVICE_API_KEY:
                return

            entity_id = event_data.get('entity_id')
            community_id = await self._get_community_for_entity(entity_id)

            if not community_id:
                return

            session = await self._get_http_session()
            payload = {
                'community_id': community_id,
                'platform': event_data.get('platform', 'unknown'),
                'platform_user_id': event_data.get('user_id', ''),
                'platform_username': event_data.get('username', ''),
                'channel_id': event_data.get('channel_id', entity_id),
                'event_type': event_data.get('message_type'),
                'metadata': event_data.get('metadata', {})
            }

            await session.post(
                f"{Config.HUB_API_URL}/api/v1/internal/activity/event",
                json=payload,
                headers={'X-Service-Key': Config.SERVICE_API_KEY},
            )
        except Exception as e:
            logger.warning(f"Failed to record stream activity: {e}")

    async def _record_message_activity(self, event_data: Dict[str, Any]):
        """Record message activity to hub for leaderboard tracking"""
        try:
            if not Config.HUB_API_URL or not Config.SERVICE_API_KEY:
                return

            # Get community_id from entity mapping (entity_id -> community)
            entity_id = event_data.get('entity_id')
            community_id = await self._get_community_for_entity(entity_id)

            if not community_id:
                return

            session = await self._get_http_session()
            payload = {
                'community_id': community_id,
                'platform': event_data.get('platform', 'unknown'),
                'platform_user_id': event_data.get('user_id', ''),
                'platform_username': event_data.get('username', ''),
                'channel_id': event_data.get('channel_id', entity_id),
            }

            await session.post(
                f"{Config.HUB_API_URL}/api/v1/internal/activity/message",
                json=payload,
                headers={'X-Service-Key': Config.SERVICE_API_KEY},
            )
        except Exception as e:
            # Don't let activity tracking failures affect message processing
            logger.warning(f"Failed to record message activity: {e}")

    async def _get_community_for_entity(self, entity_id: str) -> int | None:
        """Get community ID for an entity from cache or database"""
        if not entity_id:
            return None

        # Check cache first
        cache_key = f"entity:community:{entity_id}"
        cached = await self.cache.get(cache_key)
        if cached:
            return int(cached)

        # Query database for server -> community mapping
        try:
            result = self.dal.executesql(
                """SELECT cs.community_id FROM community_servers cs
                   WHERE cs.platform_server_id = %s AND cs.is_active = true
                   LIMIT 1""",
                [entity_id],
            )
            if result:
                community_id = result[0][0]
                await self.cache.set(cache_key, str(community_id), ttl=Config.ROUTER_ENTITY_CACHE_TTL)
                return community_id
        except Exception as e:
            logger.warning(f"Failed to lookup community for entity {entity_id}: {e}")

        return None

    async def execute_command(
        self,
        command: str,
        entity_id: str,
        user_id: str,
        message: str,
        session_id: str,
    ) -> Dict[str, Any]:
        """Execute command asynchronously"""
        # This would contain full command execution logic
        # For now, returning basic structure
        return {
            "success": True,
            "session_id": session_id,
            "command": command,
            "executed": True
        }

    async def handle_module_response(self, response_data: Dict[str, Any]):
        """Handle response from interaction module"""
        # Store and route module response
        pass

    async def list_commands(self) -> List[Dict[str, Any]]:
        """List available commands"""
        # Query commands from database
        return []

    async def get_metrics(self) -> Dict[str, Any]:
        """Get performance metrics"""
        return {
            "requests_processed": 0,
            "avg_response_time_ms": 0,
            "cache_hit_rate": 0
        }
