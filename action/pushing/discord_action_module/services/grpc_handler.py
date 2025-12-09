"""
gRPC Handler for Discord Action Module

Handles incoming gRPC requests from processor/router
"""

import logging
from typing import Optional

import grpc
import jwt
from proto import discord_action_pb2, discord_action_pb2_grpc

from config import Config
from services.discord_service import DiscordService

logger = logging.getLogger(__name__)


class DiscordActionServicer(discord_action_pb2_grpc.DiscordActionServicer):
    """gRPC servicer for Discord actions"""

    def __init__(self, discord_service: DiscordService):
        """
        Initialize gRPC servicer

        Args:
            discord_service: Discord API service instance
        """
        self.discord_service = discord_service

    def _verify_token(self, token: str) -> tuple[bool, Optional[str]]:
        """
        Verify JWT token

        Args:
            token: JWT token string

        Returns:
            Tuple of (valid, error_message)
        """
        try:
            jwt.decode(
                token,
                Config.MODULE_SECRET_KEY,
                algorithms=[Config.JWT_ALGORITHM],
            )
            return True, None
        except jwt.ExpiredSignatureError:
            return False, "Token expired"
        except jwt.InvalidTokenError as e:
            return False, f"Invalid token: {str(e)}"

    def _embed_to_dict(self, embed: discord_action_pb2.EmbedData) -> dict:
        """Convert protobuf embed to Discord API dict"""
        result = {}

        if embed.title:
            result["title"] = embed.title
        if embed.description:
            result["description"] = embed.description
        if embed.color:
            result["color"] = int(embed.color, 16)
        if embed.url:
            result["url"] = embed.url
        if embed.thumbnail_url:
            result["thumbnail"] = {"url": embed.thumbnail_url}
        if embed.image_url:
            result["image"] = {"url": embed.image_url}
        if embed.footer_text:
            result["footer"] = {"text": embed.footer_text}
            if embed.footer_icon_url:
                result["footer"]["icon_url"] = embed.footer_icon_url
        if embed.fields:
            result["fields"] = [
                {
                    "name": field.name,
                    "value": field.value,
                    "inline": field.inline,
                }
                for field in embed.fields
            ]

        return result

    async def SendMessage(
        self,
        request: discord_action_pb2.SendMessageRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.SendMessageResponse:
        """Send message to Discord channel"""
        # Verify token
        valid, error = self._verify_token(request.token)
        if not valid:
            logger.warning(f"Token verification failed: {error}")
            return discord_action_pb2.SendMessageResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        # Convert embed if present
        embed = None
        if request.HasField("embed"):
            embed = self._embed_to_dict(request.embed)

        # Send message
        success, message_id, error = await self.discord_service.send_message(
            request.channel_id, request.content, embed
        )

        return discord_action_pb2.SendMessageResponse(
            success=success, message_id=message_id or "", error=error or ""
        )

    async def SendEmbed(
        self,
        request: discord_action_pb2.SendEmbedRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.SendEmbedResponse:
        """Send embed to Discord channel"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.SendEmbedResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        embed = self._embed_to_dict(request.embed)
        success, message_id, error = await self.discord_service.send_embed(
            request.channel_id, embed
        )

        return discord_action_pb2.SendEmbedResponse(
            success=success, message_id=message_id or "", error=error or ""
        )

    async def AddReaction(
        self,
        request: discord_action_pb2.AddReactionRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.AddReactionResponse:
        """Add reaction to message"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.AddReactionResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.add_reaction(
            request.channel_id, request.message_id, request.emoji
        )

        return discord_action_pb2.AddReactionResponse(
            success=success, error=error or ""
        )

    async def ManageRole(
        self,
        request: discord_action_pb2.ManageRoleRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.ManageRoleResponse:
        """Add or remove role from user"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.ManageRoleResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.manage_role(
            request.guild_id, request.user_id, request.role_id, request.action
        )

        return discord_action_pb2.ManageRoleResponse(
            success=success, error=error or ""
        )

    async def CreateWebhook(
        self,
        request: discord_action_pb2.CreateWebhookRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.CreateWebhookResponse:
        """Create webhook for channel"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.CreateWebhookResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, webhook_url, error = await self.discord_service.create_webhook(
            request.channel_id, request.name
        )

        return discord_action_pb2.CreateWebhookResponse(
            success=success, webhook_url=webhook_url or "", error=error or ""
        )

    async def SendWebhook(
        self,
        request: discord_action_pb2.SendWebhookRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.SendWebhookResponse:
        """Send message via webhook"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.SendWebhookResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        embeds = None
        if request.embeds:
            embeds = [self._embed_to_dict(embed) for embed in request.embeds]

        success, error = await self.discord_service.send_webhook(
            request.webhook_url, request.content, embeds
        )

        return discord_action_pb2.SendWebhookResponse(
            success=success, error=error or ""
        )

    async def DeleteMessage(
        self,
        request: discord_action_pb2.DeleteMessageRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.DeleteMessageResponse:
        """Delete message"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.DeleteMessageResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.delete_message(
            request.channel_id, request.message_id
        )

        return discord_action_pb2.DeleteMessageResponse(
            success=success, error=error or ""
        )

    async def EditMessage(
        self,
        request: discord_action_pb2.EditMessageRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.EditMessageResponse:
        """Edit message"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.EditMessageResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.edit_message(
            request.channel_id, request.message_id, request.content
        )

        return discord_action_pb2.EditMessageResponse(
            success=success, error=error or ""
        )

    async def KickUser(
        self,
        request: discord_action_pb2.KickUserRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.KickUserResponse:
        """Kick user from guild"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.KickUserResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.kick_user(
            request.guild_id, request.user_id, request.reason or None
        )

        return discord_action_pb2.KickUserResponse(
            success=success, error=error or ""
        )

    async def BanUser(
        self,
        request: discord_action_pb2.BanUserRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.BanUserResponse:
        """Ban user from guild"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.BanUserResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.ban_user(
            request.guild_id,
            request.user_id,
            request.reason or None,
            request.delete_message_days,
        )

        return discord_action_pb2.BanUserResponse(
            success=success, error=error or ""
        )

    async def TimeoutUser(
        self,
        request: discord_action_pb2.TimeoutUserRequest,
        context: grpc.aio.ServicerContext,
    ) -> discord_action_pb2.TimeoutUserResponse:
        """Timeout user for specified duration"""
        valid, error = self._verify_token(request.token)
        if not valid:
            return discord_action_pb2.TimeoutUserResponse(
                success=False, error=f"Authentication failed: {error}"
            )

        success, error = await self.discord_service.timeout_user(
            request.guild_id,
            request.user_id,
            request.duration_seconds,
            request.reason or None,
        )

        return discord_action_pb2.TimeoutUserResponse(
            success=success, error=error or ""
        )
