"""
Slack Bolt Service - Event-driven Slack integration
Supports slash commands (/waddlebot), prefix commands (!), modals, and buttons
"""
import re
import asyncio
from typing import Dict, Any, Optional, Callable
import httpx
from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler

from flask_core import setup_aaa_logging


class SlackBoltService:
    """
    Slack Bolt service supporting:
    - Slash commands (/waddlebot)
    - Prefix commands (!) via message events
    - Modal dialogs
    - Button/select interactions
    - Block Kit messages
    """

    def __init__(
        self,
        bot_token: str,
        signing_secret: str,
        app_token: Optional[str],
        router_url: str,
        dal,
        use_socket_mode: bool = False,
        log_level: str = 'INFO'
    ):
        self.bot_token = bot_token
        self.signing_secret = signing_secret
        self.app_token = app_token
        self.router_url = router_url
        self.dal = dal
        self.use_socket_mode = use_socket_mode and app_token
        self.logger = setup_aaa_logging('slack_bolt', '2.0.0')
        self._http_session: Optional[httpx.AsyncClient] = None
        self._socket_handler: Optional[AsyncSocketModeHandler] = None

        # Create Slack Bolt App
        self.app = AsyncApp(
            token=bot_token,
            signing_secret=signing_secret
        )

        # Setup all handlers
        self._setup_handlers()

    def _setup_handlers(self):
        """Register all Slack event handlers"""

        # Slash command handler
        @self.app.command("/waddlebot")
        async def handle_waddlebot_command(ack, body, respond):
            await ack()
            await self._handle_slash_command(body, respond)

        # Message events for !prefix commands
        @self.app.event("message")
        async def handle_message(event, say):
            await self._handle_message_event(event, say)

        # App mention events
        @self.app.event("app_mention")
        async def handle_mention(event, say):
            await self._handle_mention_event(event, say)

        # Button/action handler (catch-all pattern)
        @self.app.action(re.compile(".*"))
        async def handle_action(ack, body, respond):
            await ack()
            await self._handle_action(body, respond)

        # Modal submission handler (catch-all pattern)
        @self.app.view(re.compile(".*"))
        async def handle_view_submission(ack, body, view):
            await ack()
            await self._handle_modal_submit(body, view)

        # Shortcut handler
        @self.app.shortcut(re.compile(".*"))
        async def handle_shortcut(ack, body, client):
            await ack()
            await self._handle_shortcut(body, client)

    async def _handle_slash_command(self, body: Dict[str, Any], respond: Callable):
        """Handle /waddlebot slash command"""
        user_id = body.get('user_id', '')
        channel_id = body.get('channel_id', '')
        team_id = body.get('team_id', '')
        text = body.get('text', '').strip()
        trigger_id = body.get('trigger_id', '')
        response_url = body.get('response_url', '')

        # Parse subcommand if present
        parts = text.split(maxsplit=1)
        subcommand = parts[0] if parts else 'help'
        args = parts[1] if len(parts) > 1 else ''

        event_data = {
            "entity_id": f"{team_id}:{channel_id}",
            "user_id": user_id,
            "username": body.get('user_name', ''),
            "message": f"/waddlebot {text}",
            "message_type": "slashCommand",
            "platform": "slack",
            "channel_id": channel_id,
            "server_id": team_id,
            "metadata": {
                "trigger_id": trigger_id,
                "response_url": response_url,
                "command": "/waddlebot",
                "subcommand": subcommand,
                "text": args
            }
        }

        response = await self._send_to_router(event_data)
        await self._execute_response(respond, response, trigger_id)

    async def _handle_message_event(self, event: Dict[str, Any], say: Callable):
        """Handle message events, check for !prefix commands"""
        # Ignore bot messages and message edits
        if event.get('bot_id') or event.get('subtype'):
            return

        text = event.get('text', '')
        if not text.startswith('!'):
            return

        user_id = event.get('user', '')
        channel_id = event.get('channel', '')
        team_id = event.get('team', '')
        ts = event.get('ts', '')

        event_data = {
            "entity_id": f"{team_id}:{channel_id}",
            "user_id": user_id,
            "username": "",  # Would need to look up
            "message": text,
            "message_type": "chatMessage",
            "platform": "slack",
            "channel_id": channel_id,
            "server_id": team_id,
            "metadata": {
                "message_ts": ts,
                "thread_ts": event.get('thread_ts')
            }
        }

        response = await self._send_to_router(event_data)
        await self._execute_message_response(say, response, event)

    async def _handle_mention_event(self, event: Dict[str, Any], say: Callable):
        """Handle @bot mentions"""
        text = event.get('text', '')
        user_id = event.get('user', '')
        channel_id = event.get('channel', '')
        team_id = event.get('team', '')

        # Remove the bot mention from text
        # Format: <@BOT_ID> message
        text = re.sub(r'<@[A-Z0-9]+>\s*', '', text).strip()

        event_data = {
            "entity_id": f"{team_id}:{channel_id}",
            "user_id": user_id,
            "message": text,
            "message_type": "mention",
            "platform": "slack",
            "channel_id": channel_id,
            "server_id": team_id,
            "metadata": {
                "message_ts": event.get('ts'),
                "thread_ts": event.get('thread_ts')
            }
        }

        response = await self._send_to_router(event_data)
        await self._execute_message_response(say, response, event)

    async def _handle_action(self, body: Dict[str, Any], respond: Callable):
        """Handle button/select menu actions"""
        user = body.get('user', {})
        channel = body.get('channel', {})
        team = body.get('team', {})
        actions = body.get('actions', [])

        if not actions:
            return

        action = actions[0]
        action_id = action.get('action_id', '')
        action_type = action.get('type', '')
        value = action.get('value', '')

        # Handle select menus
        if action_type == 'static_select' or action_type == 'external_select':
            selected = action.get('selected_option', {})
            value = selected.get('value', '')

        event_data = {
            "entity_id": f"{team.get('id', '')}:{channel.get('id', '')}",
            "user_id": user.get('id', ''),
            "username": user.get('username', ''),
            "message": "",
            "message_type": "interaction",
            "platform": "slack",
            "channel_id": channel.get('id', ''),
            "server_id": team.get('id', ''),
            "metadata": {
                "interaction_type": "button" if action_type == 'button' else "select",
                "action_id": action_id,
                "value": value,
                "trigger_id": body.get('trigger_id', ''),
                "response_url": body.get('response_url', ''),
                "message_ts": body.get('message', {}).get('ts')
            }
        }

        response = await self._send_to_router(event_data)
        await self._execute_response(respond, response, body.get('trigger_id'))

    async def _handle_modal_submit(self, body: Dict[str, Any], view: Dict[str, Any]):
        """Handle modal form submission"""
        user = body.get('user', {})
        team = body.get('team', {})
        callback_id = view.get('callback_id', '')

        # Extract form values
        values = {}
        state_values = view.get('state', {}).get('values', {})
        for block_id, block_data in state_values.items():
            for action_id, action_data in block_data.items():
                value = action_data.get('value') or action_data.get('selected_option', {}).get('value')
                values[action_id] = value

        event_data = {
            "entity_id": f"{team.get('id', '')}:modal",
            "user_id": user.get('id', ''),
            "username": user.get('username', ''),
            "message": "",
            "message_type": "interaction",
            "platform": "slack",
            "channel_id": "",
            "server_id": team.get('id', ''),
            "metadata": {
                "interaction_type": "modal_submit",
                "callback_id": callback_id,
                "view_id": view.get('id', ''),
                "values": values,
                "private_metadata": view.get('private_metadata', '')
            }
        }

        await self._send_to_router(event_data)

    async def _handle_shortcut(self, body: Dict[str, Any], client):
        """Handle global/message shortcuts"""
        user = body.get('user', {})
        team = body.get('team', {})
        callback_id = body.get('callback_id', '')
        trigger_id = body.get('trigger_id', '')

        event_data = {
            "entity_id": f"{team.get('id', '')}:shortcut",
            "user_id": user.get('id', ''),
            "username": user.get('username', ''),
            "message": "",
            "message_type": "shortcut",
            "platform": "slack",
            "server_id": team.get('id', ''),
            "metadata": {
                "callback_id": callback_id,
                "trigger_id": trigger_id,
                "shortcut_type": body.get('type', 'shortcut')
            }
        }

        response = await self._send_to_router(event_data)

        # If response includes modal, open it
        if response.get('action', {}).get('type') == 'modal':
            modal_config = response['action'].get('modal', {})
            await client.views_open(
                trigger_id=trigger_id,
                view=modal_config
            )

    async def _send_to_router(self, event_data: Dict[str, Any]) -> Dict[str, Any]:
        """Send event to router and get response"""
        try:
            async with self._get_http_session() as client:
                response = await client.post(
                    f"{self.router_url}/events",
                    json=event_data,
                    timeout=30.0
                )

                self.logger.audit(
                    "Event sent to router",
                    action="router_forward",
                    user=event_data.get('user_id'),
                    result="SUCCESS" if response.status_code < 400 else "FAILED"
                )

                if response.status_code == 200:
                    return response.json()
                return {"success": False, "error": "Router error"}

        except Exception as e:
            self.logger.error(f"Router communication failed: {e}")
            return {"success": False, "error": str(e)}

    async def _execute_response(
        self,
        respond: Callable,
        response: Dict[str, Any],
        trigger_id: Optional[str] = None
    ):
        """Execute router response"""
        if not response.get('success', False):
            await respond(text=response.get('error', 'Command failed'))
            return

        action = response.get('action', {})
        action_type = action.get('type', 'message')

        if action_type == 'message':
            await respond(
                text=action.get('content', ''),
                blocks=action.get('blocks'),
                response_type=action.get('response_type', 'ephemeral')
            )

        elif action_type == 'modal' and trigger_id:
            # Would need slack client to open modal
            pass

    async def _execute_message_response(
        self,
        say: Callable,
        response: Dict[str, Any],
        original_event: Dict[str, Any]
    ):
        """Execute router response for message events"""
        if not response.get('success', False):
            await say(text=response.get('error', 'Command failed'))
            return

        action = response.get('action', {})
        content = action.get('content', '')
        blocks = action.get('blocks')

        # Reply in thread if original was in thread
        thread_ts = original_event.get('thread_ts') or original_event.get('ts')

        await say(
            text=content,
            blocks=blocks,
            thread_ts=thread_ts if action.get('in_thread', True) else None
        )

    def _get_http_session(self) -> httpx.AsyncClient:
        """Get or create HTTP session"""
        if self._http_session is None or self._http_session.is_closed:
            self._http_session = httpx.AsyncClient()
        return self._http_session

    async def start_socket_mode(self):
        """Start Socket Mode handler for development"""
        if not self.app_token:
            self.logger.error("Cannot start Socket Mode without SLACK_APP_TOKEN")
            return

        self._socket_handler = AsyncSocketModeHandler(self.app, self.app_token)
        self.logger.system("Starting Slack Socket Mode", action="socket_start")
        await self._socket_handler.start_async()

    async def stop(self):
        """Stop the Slack service"""
        self.logger.system("Stopping Slack service", action="stop")
        if self._http_session and not self._http_session.is_closed:
            await self._http_session.aclose()
        if self._socket_handler:
            await self._socket_handler.close_async()

    def get_quart_handler(self):
        """Get handler for Quart integration"""
        from slack_bolt.adapter.quart import SlackRequestHandler
        return SlackRequestHandler(self.app)
