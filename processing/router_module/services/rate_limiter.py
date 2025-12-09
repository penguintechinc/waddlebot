"""
Rate Limiter - Distributed Redis-backed rate limiting

This module now uses the centralized flask_core.RateLimiter for distributed
rate limiting across multiple router instances.

Kept for backward compatibility with existing code.
"""

from flask_core import RateLimiter as CoreRateLimiter, RateLimitExceeded


class RateLimiter(CoreRateLimiter):
    """
    Router-specific rate limiter wrapper.

    Extends flask_core.RateLimiter with router-specific functionality
    while maintaining backward compatibility with existing code.
    """

    def __init__(self, redis_url: str = None):
        """
        Initialize router rate limiter.

        Args:
            redis_url: Redis connection URL
        """
        super().__init__(
            redis_url=redis_url,
            namespace="router",
            enable_fallback=True
        )


# Export for backward compatibility
__all__ = ['RateLimiter', 'RateLimitExceeded']
