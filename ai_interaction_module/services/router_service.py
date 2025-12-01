"""
Router Service
==============

Service for submitting responses back to the router module.
"""

import httpx
import logging
from typing import Dict, Any
from config import Config

logger = logging.getLogger(__name__)


class RouterService:
    """Service for communicating with router module"""

    def __init__(self):
        self.router_url = Config.ROUTER_API_URL
        logger.info(f"Initialized router service: {self.router_url}")

    async def submit_response(self, response_data: Dict[str, Any]) -> bool:
        """
        Submit module response back to router.

        Args:
            response_data: Response data dictionary

        Returns:
            True if submitted successfully, False otherwise
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.router_url}/responses",
                    json=response_data,
                    timeout=10.0
                )

                if response.status_code == 200:
                    logger.info(  # noqa: E501
                        f"Successfully submitted response for "
                        f"session {response_data.get('session_id')}"
                    )
                    return True
                else:
                    logger.error(  # noqa: E501
                        f"Failed to submit response: "
                        f"{response.status_code} - {response.text}"
                    )
                    return False

        except Exception as e:
            logger.error(f"Error submitting response to router: {e}")
            return False
