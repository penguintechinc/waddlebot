"""
Ollama Provider with TLS Support
=================================

Direct Ollama connection with configurable host:port and TLS options.
"""

import httpx
import ssl
import logging
from typing import Optional, Dict, Any
from dataclasses import dataclass, field

from config import Config

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class OllamaProvider:
    """
    Ollama AI provider with TLS support.

    Supports:
    - Configurable host and port
    - TLS/SSL with custom certificates
    - SSL verification control
    - Async HTTP requests with httpx
    """

    host: str = field(default_factory=lambda: Config.OLLAMA_HOST)
    port: str = field(default_factory=lambda: Config.OLLAMA_PORT)
    use_tls: bool = field(default_factory=lambda: Config.OLLAMA_USE_TLS)
    model: str = field(default_factory=lambda: Config.OLLAMA_MODEL)
    temperature: float = field(  # noqa: E501
        default_factory=lambda: Config.OLLAMA_TEMPERATURE
    )
    max_tokens: int = field(default_factory=lambda: Config.OLLAMA_MAX_TOKENS)
    timeout: int = field(default_factory=lambda: Config.OLLAMA_TIMEOUT)
    cert_path: str = field(default_factory=lambda: Config.OLLAMA_CERT_PATH)
    verify_ssl: bool = field(default_factory=lambda: Config.OLLAMA_VERIFY_SSL)
    base_url: str = field(init=False)
    ssl_context: Optional[ssl.SSLContext] = field(init=False, default=None)

    def __post_init__(self):
        """Initialize provider after dataclass creation"""
        # Build base URL
        protocol = 'https' if self.use_tls else 'http'
        self.base_url = f"{protocol}://{self.host}:{self.port}"

        # Setup SSL context for TLS
        self.ssl_context = None
        if self.use_tls:
            self.ssl_context = self._create_ssl_context()

        logger.info(
            f"Initialized Ollama provider: {self.base_url} "
            f"(TLS: {self.use_tls}, Model: {self.model})"
        )

    def _create_ssl_context(self) -> ssl.SSLContext:
        """
        Create SSL context for TLS connections.

        Returns:
            SSL context with appropriate settings
        """
        if self.verify_ssl:
            # Create default context with certificate verification
            context = ssl.create_default_context()

            # Load custom certificate if provided
            if self.cert_path:
                try:
                    context.load_verify_locations(self.cert_path)
                    logger.info(  # noqa: E501
                        f"Loaded custom certificate from {self.cert_path}"
                    )
                except Exception as e:
                    logger.warning(  # noqa: E501
                        f"Failed to load certificate from "
                        f"{self.cert_path}: {e}"
                    )

            return context
        else:
            # Create context without verification (development only)
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            logger.warning(  # noqa: E501
                "SSL verification disabled - not recommended for production!"
            )
            return context

    async def health_check(self) -> bool:
        """
        Check if Ollama is available.

        Returns:
            True if healthy, False otherwise
        """
        try:
            verify_param = (  # noqa: E501
                self.ssl_context if self.use_tls else True
            )
            async with httpx.AsyncClient(verify=verify_param) as client:
                response = await client.get(
                    f"{self.base_url}/api/tags",
                    timeout=5.0
                )
                return response.status_code == 200

        except httpx.ConnectError:
            logger.error(f"Cannot connect to Ollama at {self.base_url}")
            return False
        except httpx.TimeoutException:
            logger.error(f"Ollama health check timed out at {self.base_url}")
            return False
        except Exception as e:
            logger.error(f"Ollama health check failed: {e}")
            return False

    async def generate_response(
        self,
        message_content: str,
        message_type: str,
        user_id: str,
        platform: str,
        context: Dict[str, Any]
    ) -> Optional[str]:
        """
        Generate AI response using Ollama.

        Args:
            message_content: Message text
            message_type: Type of message
            user_id: User identifier
            platform: Platform name
            context: Additional context

        Returns:
            Generated response or None
        """
        try:
            # Create prompt based on message type
            prompt = self._create_prompt(
                message_content, message_type, user_id, platform, context
            )

            # Build request payload
            payload = {
                "model": self.model,
                "prompt": prompt,
                "temperature": self.temperature,
                "options": {
                    "num_predict": self.max_tokens
                },
                "stream": False  # Get complete response
            }

            # Make async request
            verify_param = (  # noqa: E501
                self.ssl_context if self.use_tls else True
            )
            async with httpx.AsyncClient(verify=verify_param) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate",
                    json=payload,
                    timeout=self.timeout
                )

                if response.status_code == 200:
                    data = response.json()
                    generated_text = data.get('response', '')

                    # Clean and validate response
                    cleaned_response = self._clean_response(generated_text)

                    logger.info(  # noqa: E501
                        f"Ollama generated response: {len(cleaned_response)} "
                        f"chars (tokens: {data.get('eval_count', 0)})"
                    )

                    return cleaned_response

                else:
                    logger.error(  # noqa: E501
                        f"Ollama request failed: {response.status_code} - "
                        f"{response.text}"
                    )
                    return None

        except httpx.TimeoutException:
            logger.error(f"Ollama request timed out after {self.timeout}s")
            return None
        except Exception as e:
            logger.error(  # noqa: E501
                f"Error generating Ollama response: {e}",
                exc_info=True
            )
            return None

    async def get_available_models(self) -> list:
        """
        Get list of available Ollama models.

        Returns:
            List of model names
        """
        try:
            verify_param = (  # noqa: E501
                self.ssl_context if self.use_tls else True
            )
            async with httpx.AsyncClient(verify=verify_param) as client:
                response = await client.get(
                    f"{self.base_url}/api/tags",
                    timeout=5.0
                )

                if response.status_code == 200:
                    data = response.json()
                    models = [  # noqa: E501
                        model['name']
                        for model in data.get('models', [])
                    ]
                    logger.info(f"Found {len(models)} Ollama models")
                    return models

                return []

        except Exception as e:
            logger.error(f"Failed to get Ollama models: {e}")
            return []

    def _create_prompt(
        self,
        message_content: str,
        message_type: str,
        user_id: str,
        platform: str,
        context: Dict[str, Any]
    ) -> str:
        """
        Create prompt for Ollama based on message type.

        Args:
            message_content: Message text
            message_type: Type of message
            user_id: User identifier
            platform: Platform name
            context: Additional context

        Returns:
            Formatted prompt string
        """
        # Python 3.13 pattern matching for prompt creation
        match message_type:
            case 'chatMessage':
                return self._create_chat_prompt(  # noqa: E501
                    message_content, user_id, platform, context
                )
            case _:
                return self._create_event_prompt(  # noqa: E501
                    message_type, user_id, platform, context
                )

    def _create_chat_prompt(
        self,
        message_content: str,
        user_id: str,
        platform: str,
        context: Dict[str, Any]
    ) -> str:
        """Create prompt for chat messages"""

        trigger_type = context.get('trigger_type', 'unknown')

        # Build context-aware system prompt
        prompt_parts = [Config.SYSTEM_PROMPT]

        # Add platform context
        prompt_parts.append(f"\nPlatform: {platform}")

        # Add trigger-specific context
        match trigger_type:
            case 'greeting':
                prompt_parts.append(  # noqa: E501
                    "The user is greeting you. Respond warmly and friendly."
                )
            case 'farewell':
                prompt_parts.append(  # noqa: E501
                    "The user is saying goodbye. "
                    "Respond with a friendly farewell."
                )
            case 'question':
                prompt_parts.append(  # noqa: E501
                    "The user is asking a question. "
                    "Provide a helpful, informative answer."
                )
            case _:
                prompt_parts.append(  # noqa: E501
                    "Respond helpfully and naturally to the user's message."
                )

        # Add user message
        prompt_parts.append(f"\nUser {user_id} said: {message_content}")

        # Add conversation history if available
        if Config.ENABLE_CHAT_CONTEXT and 'conversation_history' in context:
            history = context['conversation_history']
            if history:
                prompt_parts.insert(1, "\nRecent conversation:")
                for msg in history[-3:]:  # Last 3 messages
                    role = msg.get('role', 'unknown')
                    content = msg.get('content', '')
                    prompt_parts.insert(2, f"{role}: {content}")

        prompt_parts.append("\nYour response (keep it under 200 characters):")

        return '\n'.join(prompt_parts)

    def _create_event_prompt(
        self,
        message_type: str,
        user_id: str,
        platform: str,
        context: Dict[str, Any]
    ) -> str:
        """Create prompt for event responses"""

        # Event-specific prompts using pattern matching
        match message_type:
            case 'subscription':
                event_desc = f"User {user_id} just subscribed!"
                instruction = "Generate a celebratory thank you message."

            case 'follow':
                event_desc = f"User {user_id} just followed!"
                instruction = "Generate a welcoming thank you message."

            case 'donation':
                event_desc = f"User {user_id} just made a donation!"
                instruction = "Generate a grateful thank you message."

            case 'cheer':
                event_desc = f"User {user_id} just sent bits!"
                instruction = "Generate an excited thank you message."

            case 'raid':
                event_desc = f"User {user_id} just raided the channel!"
                instruction = "Generate a welcoming message for the raiders."

            case 'boost':
                event_desc = f"User {user_id} just boosted the server!"
                instruction = "Generate a thank you message for the boost."

            case 'member_join':
                event_desc = f"User {user_id} just joined!"
                instruction = "Generate a welcoming message."

            case _:
                event_desc = (  # noqa: E501
                    f"User {user_id} triggered a {message_type} event!"
                )
                instruction = "Generate an appropriate response."

        return f"""{Config.SYSTEM_PROMPT}

Platform: {platform}
Event: {event_desc}

{instruction}
Keep it short, enthusiastic, and under 150 characters:"""

    def _clean_response(self, response: str) -> str:
        """
        Clean and validate AI response.

        Args:
            response: Raw AI response

        Returns:
            Cleaned response text
        """
        if not response:
            return ""

        # Strip whitespace
        cleaned = response.strip()

        # Remove any leaked system prompts
        if cleaned.lower().startswith("you are"):
            lines = cleaned.split('\n')
            for i, line in enumerate(lines):
                if not line.lower().startswith("you are") and line.strip():
                    cleaned = '\n'.join(lines[i:])
                    break

        # Remove markdown formatting if present
        cleaned = cleaned.replace('**', '').replace('*', '')

        # Limit length for chat readability
        if len(cleaned) > 400:
            cleaned = cleaned[:397] + "..."

        # Remove multiple newlines
        while '\n\n' in cleaned:
            cleaned = cleaned.replace('\n\n', '\n')

        return cleaned.strip()
