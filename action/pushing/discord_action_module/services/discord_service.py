"""
Discord API Service

Handles all Discord API interactions
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

import aiohttp
from pydal import DAL, Field

from config import Config

logger = logging.getLogger(__name__)


class DiscordService:
    """Service for Discord API operations"""

    def __init__(self, db: DAL):
        """
        Initialize Discord service

        Args:
            db: PyDAL database instance
        """
        self.db = db
        self.bot_token = Config.DISCORD_BOT_TOKEN
        self.api_base = Config.DISCORD_API_BASE
        self.session: Optional[aiohttp.ClientSession] = None
        self._rate_limits = {}
        self._rate_limit_lock = asyncio.Lock()

        # Define activity log table
        self.db.define_table(
            "discord_actions",
            Field("action_type", "string", required=True),
            Field("guild_id", "string"),
            Field("channel_id", "string"),
            Field("user_id", "string"),
            Field("success", "boolean", default=True),
            Field("error_message", "text"),
            Field("request_data", "json"),
            Field("response_data", "json"),
            Field("created_at", "datetime", default=datetime.utcnow),
            migrate=False,
        )

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session"""
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bot {self.bot_token}",
                    "Content-Type": "application/json",
                    "User-Agent": f"WaddleBot/{Config.MODULE_VERSION}",
                }
            )
        return self.session

    async def _check_rate_limit(self, endpoint: str) -> None:
        """Check and enforce rate limits"""
        async with self._rate_limit_lock:
            if endpoint in self._rate_limits:
                reset_time = self._rate_limits[endpoint]
                if datetime.utcnow() < reset_time:
                    wait_time = (reset_time - datetime.utcnow()).total_seconds()
                    logger.warning(f"Rate limited on {endpoint}, waiting {wait_time}s")
                    await asyncio.sleep(wait_time)

    async def _log_action(
        self,
        action_type: str,
        guild_id: Optional[str] = None,
        channel_id: Optional[str] = None,
        user_id: Optional[str] = None,
        success: bool = True,
        error_message: Optional[str] = None,
        request_data: Optional[dict] = None,
        response_data: Optional[dict] = None,
    ) -> None:
        """Log action to database"""
        try:
            self.db.discord_actions.insert(
                action_type=action_type,
                guild_id=guild_id,
                channel_id=channel_id,
                user_id=user_id,
                success=success,
                error_message=error_message,
                request_data=request_data,
                response_data=response_data,
            )
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to log action: {e}")

    async def _make_request(
        self,
        method: str,
        endpoint: str,
        json_data: Optional[dict] = None,
        retry: int = 0,
    ) -> tuple[bool, Optional[dict], Optional[str]]:
        """
        Make Discord API request

        Args:
            method: HTTP method
            endpoint: API endpoint
            json_data: JSON payload
            retry: Current retry count

        Returns:
            Tuple of (success, response_data, error_message)
        """
        await self._check_rate_limit(endpoint)
        session = await self._get_session()
        url = f"{self.api_base}{endpoint}"

        try:
            async with session.request(
                method, url, json=json_data, timeout=Config.REQUEST_TIMEOUT
            ) as response:
                # Handle rate limiting
                if response.status == 429:
                    retry_after = float(response.headers.get("Retry-After", "1"))
                    logger.warning(f"Rate limited, retry after {retry_after}s")
                    async with self._rate_limit_lock:
                        self._rate_limits[endpoint] = datetime.utcnow() + timedelta(
                            seconds=retry_after
                        )
                    if retry < Config.MAX_RETRIES:
                        await asyncio.sleep(retry_after)
                        return await self._make_request(
                            method, endpoint, json_data, retry + 1
                        )
                    return False, None, "Rate limit exceeded, max retries reached"

                # Handle success
                if 200 <= response.status < 300:
                    try:
                        data = await response.json()
                        return True, data, None
                    except Exception:
                        return True, None, None

                # Handle errors
                error_text = await response.text()
                logger.error(
                    f"Discord API error {response.status}: {error_text}"
                )
                return False, None, f"API error {response.status}: {error_text}"

        except asyncio.TimeoutError:
            logger.error(f"Request timeout for {endpoint}")
            if retry < Config.MAX_RETRIES:
                await asyncio.sleep(Config.RETRY_DELAY * (retry + 1))
                return await self._make_request(
                    method, endpoint, json_data, retry + 1
                )
            return False, None, "Request timeout"
        except Exception as e:
            logger.error(f"Request failed: {e}")
            return False, None, str(e)

    async def send_message(
        self,
        channel_id: str,
        content: str,
        embed: Optional[dict] = None,
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """
        Send message to channel

        Args:
            channel_id: Discord channel ID
            content: Message content
            embed: Optional embed data

        Returns:
            Tuple of (success, message_id, error_message)
        """
        endpoint = f"/channels/{channel_id}/messages"
        payload = {"content": content}
        if embed:
            payload["embeds"] = [embed]

        success, data, error = await self._make_request("POST", endpoint, payload)

        await self._log_action(
            "send_message",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data=payload,
            response_data=data,
        )

        message_id = data.get("id") if data else None
        return success, message_id, error

    async def send_embed(
        self, channel_id: str, embed: dict
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """Send embed to channel"""
        endpoint = f"/channels/{channel_id}/messages"
        payload = {"embeds": [embed]}

        success, data, error = await self._make_request("POST", endpoint, payload)

        await self._log_action(
            "send_embed",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data=payload,
            response_data=data,
        )

        message_id = data.get("id") if data else None
        return success, message_id, error

    async def add_reaction(
        self, channel_id: str, message_id: str, emoji: str
    ) -> tuple[bool, Optional[str]]:
        """Add reaction to message"""
        # URL encode emoji
        import urllib.parse

        encoded_emoji = urllib.parse.quote(emoji)
        endpoint = f"/channels/{channel_id}/messages/{message_id}/reactions/{encoded_emoji}/@me"

        success, _, error = await self._make_request("PUT", endpoint)

        await self._log_action(
            "add_reaction",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data={"message_id": message_id, "emoji": emoji},
        )

        return success, error

    async def manage_role(
        self, guild_id: str, user_id: str, role_id: str, action: str
    ) -> tuple[bool, Optional[str]]:
        """Add or remove role from user"""
        endpoint = f"/guilds/{guild_id}/members/{user_id}/roles/{role_id}"
        method = "PUT" if action.lower() == "add" else "DELETE"

        success, _, error = await self._make_request(method, endpoint)

        await self._log_action(
            f"manage_role_{action}",
            guild_id=guild_id,
            user_id=user_id,
            success=success,
            error_message=error,
            request_data={"role_id": role_id, "action": action},
        )

        return success, error

    async def create_webhook(
        self, channel_id: str, name: str
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """Create webhook for channel"""
        endpoint = f"/channels/{channel_id}/webhooks"
        payload = {"name": name}

        success, data, error = await self._make_request("POST", endpoint, payload)

        webhook_url = None
        if success and data:
            webhook_id = data.get("id")
            webhook_token = data.get("token")
            if webhook_id and webhook_token:
                webhook_url = f"https://discord.com/api/webhooks/{webhook_id}/{webhook_token}"

        await self._log_action(
            "create_webhook",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data=payload,
            response_data=data,
        )

        return success, webhook_url, error

    async def send_webhook(
        self, webhook_url: str, content: str, embeds: Optional[list[dict]] = None
    ) -> tuple[bool, Optional[str]]:
        """Send message via webhook"""
        payload = {"content": content}
        if embeds:
            payload["embeds"] = embeds

        session = await self._get_session()
        try:
            async with session.post(
                webhook_url, json=payload, timeout=Config.REQUEST_TIMEOUT
            ) as response:
                success = 200 <= response.status < 300
                error = None if success else await response.text()

                await self._log_action(
                    "send_webhook",
                    success=success,
                    error_message=error,
                    request_data=payload,
                )

                return success, error
        except Exception as e:
            logger.error(f"Webhook request failed: {e}")
            await self._log_action(
                "send_webhook",
                success=False,
                error_message=str(e),
                request_data=payload,
            )
            return False, str(e)

    async def delete_message(
        self, channel_id: str, message_id: str
    ) -> tuple[bool, Optional[str]]:
        """Delete message"""
        endpoint = f"/channels/{channel_id}/messages/{message_id}"
        success, _, error = await self._make_request("DELETE", endpoint)

        await self._log_action(
            "delete_message",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data={"message_id": message_id},
        )

        return success, error

    async def edit_message(
        self, channel_id: str, message_id: str, content: str
    ) -> tuple[bool, Optional[str]]:
        """Edit message"""
        endpoint = f"/channels/{channel_id}/messages/{message_id}"
        payload = {"content": content}

        success, _, error = await self._make_request("PATCH", endpoint, payload)

        await self._log_action(
            "edit_message",
            channel_id=channel_id,
            success=success,
            error_message=error,
            request_data={"message_id": message_id, "content": content},
        )

        return success, error

    async def kick_user(
        self, guild_id: str, user_id: str, reason: Optional[str] = None
    ) -> tuple[bool, Optional[str]]:
        """Kick user from guild"""
        endpoint = f"/guilds/{guild_id}/members/{user_id}"
        headers_extra = {}
        if reason:
            headers_extra["X-Audit-Log-Reason"] = reason

        session = await self._get_session()
        try:
            async with session.delete(
                f"{self.api_base}{endpoint}",
                headers=headers_extra,
                timeout=Config.REQUEST_TIMEOUT,
            ) as response:
                success = 200 <= response.status < 300
                error = None if success else await response.text()

                await self._log_action(
                    "kick_user",
                    guild_id=guild_id,
                    user_id=user_id,
                    success=success,
                    error_message=error,
                    request_data={"reason": reason},
                )

                return success, error
        except Exception as e:
            logger.error(f"Kick user failed: {e}")
            await self._log_action(
                "kick_user",
                guild_id=guild_id,
                user_id=user_id,
                success=False,
                error_message=str(e),
                request_data={"reason": reason},
            )
            return False, str(e)

    async def ban_user(
        self,
        guild_id: str,
        user_id: str,
        reason: Optional[str] = None,
        delete_message_days: int = 0,
    ) -> tuple[bool, Optional[str]]:
        """Ban user from guild"""
        endpoint = f"/guilds/{guild_id}/bans/{user_id}"
        payload = {"delete_message_days": delete_message_days}
        if reason:
            payload["reason"] = reason

        success, _, error = await self._make_request("PUT", endpoint, payload)

        await self._log_action(
            "ban_user",
            guild_id=guild_id,
            user_id=user_id,
            success=success,
            error_message=error,
            request_data=payload,
        )

        return success, error

    async def timeout_user(
        self,
        guild_id: str,
        user_id: str,
        duration_seconds: int,
        reason: Optional[str] = None,
    ) -> tuple[bool, Optional[str]]:
        """Timeout user (mute) for specified duration"""
        endpoint = f"/guilds/{guild_id}/members/{user_id}"
        timeout_until = (
            datetime.utcnow() + timedelta(seconds=duration_seconds)
        ).isoformat()
        payload = {"communication_disabled_until": timeout_until}

        session = await self._get_session()
        headers_extra = {}
        if reason:
            headers_extra["X-Audit-Log-Reason"] = reason

        try:
            async with session.patch(
                f"{self.api_base}{endpoint}",
                json=payload,
                headers=headers_extra,
                timeout=Config.REQUEST_TIMEOUT,
            ) as response:
                success = 200 <= response.status < 300
                error = None if success else await response.text()

                await self._log_action(
                    "timeout_user",
                    guild_id=guild_id,
                    user_id=user_id,
                    success=success,
                    error_message=error,
                    request_data={"duration_seconds": duration_seconds, "reason": reason},
                )

                return success, error
        except Exception as e:
            logger.error(f"Timeout user failed: {e}")
            await self._log_action(
                "timeout_user",
                guild_id=guild_id,
                user_id=user_id,
                success=False,
                error_message=str(e),
                request_data={"duration_seconds": duration_seconds, "reason": reason},
            )
            return False, str(e)

    async def close(self) -> None:
        """Close aiohttp session"""
        if self.session and not self.session.closed:
            await self.session.close()
