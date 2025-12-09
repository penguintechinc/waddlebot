"""Command Processor - Async command routing and execution"""
import asyncio
import logging
from typing import Any, Dict, List, Optional
import json

import aiohttp

from config import Config
from services.command_registry import CommandRegistry, CommandInfo

logger = logging.getLogger(__name__)


class CommandProcessor:
    def __init__(self, dal, cache_manager, rate_limiter, session_manager, command_registry: CommandRegistry):
        self.dal = dal
        self.cache = cache_manager
        self.rate_limiter = rate_limiter
        self.session_manager = session_manager
        self.command_registry = command_registry
        self._http_session = None
        self._response_cache: Dict[str, Any] = {}  # session_id -> response

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
                # Forward reputation-impacting events
                if message_type in ('subscription', 'gift_subscription', 'follow',
                                    'raid', 'cheer'):
                    asyncio.create_task(self._record_reputation_event(event_data))
                return {"success": True, "session_id": session_id, "processed": True}

            # Record message activity for leaderboards (fire-and-forget)
            if message_type == 'chatMessage':
                asyncio.create_task(self._record_message_activity(event_data))
                # Also record for reputation tracking
                asyncio.create_task(self._record_reputation_event(event_data))

            # Check for prefix commands (! or #)
            if message.startswith('!') or message.startswith('#'):
                command = message.split()[0] if message else ''

                # Check rate limit (60 requests per 60 seconds)
                if not await self.rate_limiter.check_rate_limit(f"{user_id}:{command}", limit=60, window=60):
                    return {"success": False, "error": "Rate limit exceeded"}

                # Track command usage for reputation (small penalty)
                cmd_event = {**event_data, 'message_type': 'command'}
                asyncio.create_task(self._record_reputation_event(cmd_event))

                # Execute command
                result = await self.execute_command(command, entity_id, user_id, message, session_id)

                # Check for workflows triggered by this command
                await self._check_and_trigger_workflows(command, entity_id, user_id, message, session_id, event_data)

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

        # Check rate limit (60 requests per 60 seconds)
        if not await self.rate_limiter.check_rate_limit(f"{user_id}:{command}", limit=60, window=60):
            return {"success": False, "error": "Rate limit exceeded"}

        # Track slash command usage for reputation (small penalty)
        cmd_event = {
            **event_data,
            'message_type': 'slashCommand',
            'metadata': {**metadata, 'command_name': command_name}
        }
        asyncio.create_task(self._record_reputation_event(cmd_event))

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

    async def _record_reputation_event(self, event_data: Dict[str, Any]):
        """Forward event to reputation module for score adjustment"""
        try:
            if not Config.REPUTATION_ENABLED or not Config.REPUTATION_API_URL:
                return

            entity_id = event_data.get('entity_id')
            community_id = await self._get_community_for_entity(entity_id)

            if not community_id:
                return

            session = await self._get_http_session()
            payload = {
                'community_id': community_id,
                'user_id': None,  # Will be resolved by reputation module
                'platform': event_data.get('platform', 'unknown'),
                'platform_user_id': event_data.get('user_id', ''),
                'event_type': event_data.get('message_type', 'chatMessage'),
                'metadata': {
                    'username': event_data.get('username', ''),
                    'channel_id': event_data.get('channel_id', entity_id),
                    **event_data.get('metadata', {})
                }
            }

            headers = {}
            if Config.SERVICE_API_KEY:
                headers['X-Service-Key'] = Config.SERVICE_API_KEY

            await session.post(
                f"{Config.REPUTATION_API_URL}/api/v1/internal/events",
                json=payload,
                headers=headers,
            )
        except Exception as e:
            logger.warning(f"Failed to record reputation event: {e}")

    async def execute_command(
        self,
        command: str,
        entity_id: str,
        user_id: str,
        message: str,
        session_id: str,
    ) -> Dict[str, Any]:
        """Execute command asynchronously"""
        try:
            # Get community ID for entity
            community_id = await self._get_community_for_entity(entity_id)
            if not community_id:
                return {
                    "success": False,
                    "error": "Community not found for this channel",
                    "session_id": session_id
                }

            # Look up command in registry
            cmd_info = await self.command_registry.get_command(command, community_id)
            if not cmd_info:
                # Command not found
                return {
                    "success": False,
                    "error": f"Unknown command: {command}",
                    "session_id": session_id,
                    "help_url": f"/commands"
                }

            # Check if command is enabled
            if not cmd_info.is_enabled:
                return {
                    "success": False,
                    "error": f"Command {command} is currently disabled",
                    "session_id": session_id
                }

            # Check cooldown
            if cmd_info.cooldown_seconds > 0:
                cooldown_key = f"cooldown:{user_id}:{command}"
                if not await self.rate_limiter.check_rate_limit(
                    cooldown_key,
                    limit=1,
                    window=cmd_info.cooldown_seconds
                ):
                    return {
                        "success": False,
                        "error": f"Command on cooldown. Wait {cmd_info.cooldown_seconds} seconds.",
                        "session_id": session_id
                    }

            # Parse command arguments
            parts = message.split(maxsplit=1)
            args = parts[1] if len(parts) > 1 else ""

            # Build payload for module
            payload = {
                "command": command,
                "args": args,
                "user_id": user_id,
                "entity_id": entity_id,
                "community_id": community_id,
                "session_id": session_id,
                "message": message,
            }

            # Call module HTTP endpoint with retry logic
            module_response = await self._call_module_with_retry(
                cmd_info.module_url,
                payload,
                max_retries=3
            )

            if module_response:
                # Store response for retrieval
                await self.handle_module_response({
                    "session_id": session_id,
                    "response": module_response
                })

                return {
                    "success": True,
                    "session_id": session_id,
                    "command": command,
                    "module": cmd_info.module_name,
                    "response": module_response
                }
            else:
                return {
                    "success": False,
                    "error": "Module did not respond",
                    "session_id": session_id
                }

        except Exception as e:
            logger.error(f"Error executing command {command}: {e}")
            return {
                "success": False,
                "error": str(e),
                "session_id": session_id
            }

    async def _call_module_with_retry(
        self,
        module_url: str,
        payload: Dict[str, Any],
        max_retries: int = 3
    ) -> Optional[Dict[str, Any]]:
        """Call module with exponential backoff retry"""
        session = await self._get_http_session()

        for attempt in range(max_retries):
            try:
                timeout = aiohttp.ClientTimeout(total=Config.ROUTER_REQUEST_TIMEOUT)
                headers = {}
                if Config.SERVICE_API_KEY:
                    headers['X-Service-Key'] = Config.SERVICE_API_KEY

                async with session.post(
                    f"{module_url}/api/v1/execute",
                    json=payload,
                    headers=headers,
                    timeout=timeout
                ) as response:
                    if response.status == 200:
                        return await response.json()
                    elif response.status == 429:
                        # Rate limited, wait and retry
                        wait_time = 2 ** attempt
                        logger.warning(f"Module rate limited, waiting {wait_time}s")
                        await asyncio.sleep(wait_time)
                        continue
                    else:
                        logger.error(f"Module returned status {response.status}")
                        return None

            except asyncio.TimeoutError:
                logger.warning(f"Module timeout (attempt {attempt + 1}/{max_retries})")
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return None
            except Exception as e:
                logger.error(f"Module call failed: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return None

        return None

    async def handle_module_response(self, response_data: Dict[str, Any]):
        """Handle response from interaction module"""
        try:
            session_id = response_data.get('session_id')
            response = response_data.get('response', {})

            if not session_id:
                logger.warning("No session_id in module response")
                return

            # Cache response for retrieval (1 hour TTL)
            cache_key = f"response:{session_id}"
            await self.cache.set(
                cache_key,
                json.dumps(response),
                ttl=3600
            )

            # Also store in memory for immediate access
            self._response_cache[session_id] = response

            logger.info(f"Stored module response for session {session_id}")

        except Exception as e:
            logger.error(f"Failed to handle module response: {e}")

    async def get_response(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve stored response by session ID"""
        # Check memory cache first
        if session_id in self._response_cache:
            return self._response_cache[session_id]

        # Check Redis cache
        cache_key = f"response:{session_id}"
        cached = await self.cache.get(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except json.JSONDecodeError:
                logger.error(f"Invalid JSON in cached response for {session_id}")

        return None

    async def list_commands(
        self,
        community_id: Optional[int] = None,
        category: Optional[str] = None,
        enabled_only: bool = True
    ) -> List[Dict[str, Any]]:
        """List available commands"""
        try:
            return await self.command_registry.list_commands(
                community_id=community_id,
                category=category,
                enabled_only=enabled_only
            )
        except Exception as e:
            logger.error(f"Failed to list commands: {e}")
            return []

    async def _check_and_trigger_workflows(self, command: str, entity_id: str, user_id: str, message: str, session_id: str, event_data: Dict[str, Any]):
        """Check and trigger workflows for this command/event"""
        try:
            if not Config.WORKFLOW_CORE_URL:
                return

            # Query workflows for this trigger
            workflows = await self._get_workflows_for_trigger(entity_id, command, event_data)

            if not workflows:
                return

            # Trigger workflows in parallel (fire-and-forget)
            for workflow in workflows:
                asyncio.create_task(
                    self._trigger_workflow(workflow, event_data, session_id)
                )
        except Exception as e:
            logger.warning(f"Failed to check workflows: {e}")

    async def _get_workflows_for_trigger(self, entity_id: str, command: str, event_data: Dict[str, Any]) -> List[Dict]:
        """Get active workflows for this trigger"""
        try:
            message_type = event_data.get('message_type', 'chatMessage')

            # Query workflows table for matching triggers
            query = """
                SELECT workflow_id, trigger_config
                FROM workflows
                WHERE entity_id = %s
                AND is_active = true
                AND status = 'published'
                AND (
                    (trigger_type = 'command' AND trigger_config->>'command' = %s)
                    OR (trigger_type = 'event' AND trigger_config->>'event_type' = %s)
                )
            """
            result = self.dal.executesql(query, [entity_id, command, message_type])

            workflows = []
            for row in result:
                workflows.append({
                    'workflow_id': row[0],
                    'trigger_config': row[1]
                })

            return workflows
        except Exception as e:
            logger.error(f"Failed to query workflows: {e}")
            return []

    async def _trigger_workflow(self, workflow: Dict, event_data: Dict[str, Any], session_id: str):
        """Trigger workflow execution"""
        try:
            if not Config.WORKFLOW_CORE_URL:
                return

            session = await self._get_http_session()
            payload = {
                'trigger_source': event_data.get('message_type', 'command'),
                'trigger_data': event_data,
                'session_id': session_id,
                'entity_id': event_data.get('entity_id'),
                'user_id': event_data.get('user_id'),
                'platform': event_data.get('platform', 'unknown')
            }

            headers = {}
            if Config.SERVICE_API_KEY:
                headers['X-Service-Key'] = Config.SERVICE_API_KEY

            await session.post(
                f"{Config.WORKFLOW_CORE_URL}/api/v1/workflows/{workflow['workflow_id']}/execute",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=2)
            )
            logger.info(f"Triggered workflow {workflow['workflow_id']} for session {session_id}")
        except Exception as e:
            logger.warning(f"Failed to trigger workflow: {e}")

    async def get_metrics(self) -> Dict[str, Any]:
        """Get performance metrics"""
        return {
            "requests_processed": 0,
            "avg_response_time_ms": 0,
            "cache_hit_rate": 0
        }
