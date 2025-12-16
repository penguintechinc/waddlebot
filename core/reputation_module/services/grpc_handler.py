"""
gRPC Handler for Reputation Module

Handles incoming gRPC requests for reputation operations.
Implements JWT token verification and delegates to core services.
"""

import logging
from typing import Optional

import grpc
import jwt
from proto import reputation_pb2, reputation_pb2_grpc

from config import Config

logger = logging.getLogger(__name__)


class ReputationServiceServicer(reputation_pb2_grpc.ReputationServiceServicer):
    """gRPC servicer for Reputation operations"""

    def __init__(self, reputation_service, event_processor):
        """
        Initialize gRPC servicer

        Args:
            reputation_service: ReputationService instance for score operations
            event_processor: EventProcessor instance for event processing
        """
        self.reputation_service = reputation_service
        self.event_processor = event_processor

    def _verify_token(self, token: str) -> tuple[bool, Optional[str]]:
        """
        Verify JWT token

        Args:
            token: JWT token string

        Returns:
            Tuple of (valid, error_message)
        """
        if not token:
            return False, "Token is required"

        if not Config.SECRET_KEY:
            logger.warning("SECRET_KEY not configured")
            return False, "Authentication not configured"

        try:
            jwt.decode(
                token,
                Config.SECRET_KEY,
                algorithms=["HS256"],
            )
            return True, None
        except jwt.ExpiredSignatureError:
            return False, "Token expired"
        except jwt.InvalidTokenError as e:
            return False, f"Invalid token: {str(e)}"

    async def RecordEvent(
        self,
        request: reputation_pb2.RecordEventRequest,
        context: grpc.aio.ServicerContext,
    ) -> reputation_pb2.SuccessResponse:
        """
        Record a reputation event for a user

        Verifies token, processes the event through the event processor,
        and returns success/failure status.
        """
        # Verify token
        valid, error = self._verify_token(request.token)
        if not valid:
            logger.warning(f"Token verification failed: {error}")
            return reputation_pb2.SuccessResponse(
                success=False,
                message="",
                error=f"Authentication failed: {error}",
            )

        try:
            # Convert metadata from protobuf map to dict
            metadata = dict(request.metadata) if request.metadata else {}

            # Create event dict from request
            event = {
                "community_id": request.community_id,
                "user_id": request.user_id if request.user_id > 0 else None,
                "platform": request.platform,
                "platform_user_id": request.platform_user_id,
                "event_type": request.event_type,
                "metadata": metadata,
            }

            # Process the event
            result = await self.event_processor.process_batch([event])

            if result.processed > 0:
                return reputation_pb2.SuccessResponse(
                    success=True,
                    message=f"Event processed successfully: {result.processed} event(s) processed",
                    error="",
                )
            elif result.skipped > 0:
                return reputation_pb2.SuccessResponse(
                    success=True,
                    message=f"Event skipped: {result.results[0].skip_reason if result.results else 'unknown reason'}",
                    error="",
                )
            else:
                error_msg = (
                    result.results[0].error if result.results else "Unknown error"
                )
                return reputation_pb2.SuccessResponse(
                    success=False,
                    message="",
                    error=f"Failed to process event: {error_msg}",
                )

        except Exception as e:
            logger.error(f"Error processing reputation event: {e}", exc_info=True)
            return reputation_pb2.SuccessResponse(
                success=False,
                message="",
                error=f"Internal error: {str(e)}",
            )

    async def GetScore(
        self,
        request: reputation_pb2.GetScoreRequest,
        context: grpc.aio.ServicerContext,
    ) -> reputation_pb2.GetScoreResponse:
        """
        Get reputation score for a user

        Verifies token and retrieves the current reputation score and tier.
        """
        # Verify token
        valid, error = self._verify_token(request.token)
        if not valid:
            logger.warning(f"Token verification failed: {error}")
            return reputation_pb2.GetScoreResponse(
                success=False,
                score=0,
                label="",
                error=f"Authentication failed: {error}",
            )

        try:
            # Get reputation info
            info = await self.reputation_service.get_reputation(
                request.community_id, request.user_id
            )

            if not info:
                # Return default reputation if user not found
                return reputation_pb2.GetScoreResponse(
                    success=True,
                    score=Config.REPUTATION_DEFAULT,
                    label="fair",
                    error="",
                )

            return reputation_pb2.GetScoreResponse(
                success=True,
                score=info.score,
                label=info.tier,
                error="",
            )

        except Exception as e:
            logger.error(f"Error retrieving reputation score: {e}", exc_info=True)
            return reputation_pb2.GetScoreResponse(
                success=False,
                score=0,
                label="",
                error=f"Internal error: {str(e)}",
            )
