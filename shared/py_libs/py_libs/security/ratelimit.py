"""
Rate limiting with in-memory and Redis support.

Prevents abuse by limiting request rates per client. Supports:
- Sliding window rate limiting
- In-memory storage for single-instance deployments
- Redis storage for distributed deployments
- Customizable key generation and response handling
"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Tuple

# Try to import Redis, make it optional
try:
    from redis.asyncio import Redis as AsyncRedis
    REDIS_AVAILABLE = True
except ImportError:
    AsyncRedis = None  # type: ignore
    REDIS_AVAILABLE = False


@dataclass(slots=True)
class RateLimitConfig:
    """Rate limit configuration."""
    window_seconds: int = 60
    max_requests: int = 100
    key_prefix: str = "ratelimit:"
    include_headers: bool = True


class RateLimitExceeded(Exception):
    """Raised when rate limit is exceeded."""

    def __init__(self, retry_after: int, limit: int, remaining: int):
        self.retry_after = retry_after
        self.limit = limit
        self.remaining = remaining
        super().__init__(f"Rate limit exceeded. Retry after {retry_after} seconds.")


@dataclass
class RateLimitResult:
    """Result of a rate limit check."""
    allowed: bool
    limit: int
    remaining: int
    reset_time: int  # Unix timestamp when the limit resets
    retry_after: Optional[int] = None  # Seconds until retry allowed (if blocked)


class InMemoryStorage:
    """In-memory storage for rate limit counters."""

    def __init__(self):
        self._store: Dict[str, Tuple[int, float]] = {}  # key -> (count, reset_time)
        self._lock = asyncio.Lock()

    async def increment(
        self,
        key: str,
        window_seconds: int
    ) -> Tuple[int, int]:
        """
        Increment counter for key.

        Returns:
            Tuple of (current_count, ttl_seconds).
        """
        async with self._lock:
            now = time.time()
            entry = self._store.get(key)

            if entry is None or entry[1] < now:
                # New window
                reset_time = now + window_seconds
                self._store[key] = (1, reset_time)
                return 1, window_seconds

            # Increment existing
            count, reset_time = entry
            count += 1
            self._store[key] = (count, reset_time)
            ttl = max(0, int(reset_time - now))

            return count, ttl

    async def get_count(self, key: str) -> int:
        """Get current count for key."""
        async with self._lock:
            entry = self._store.get(key)
            if entry is None or entry[1] < time.time():
                return 0
            return entry[0]

    async def reset(self, key: str) -> None:
        """Reset counter for key."""
        async with self._lock:
            self._store.pop(key, None)

    async def cleanup(self) -> int:
        """Remove expired entries. Returns number removed."""
        async with self._lock:
            now = time.time()
            expired_keys = [k for k, v in self._store.items() if v[1] < now]
            for key in expired_keys:
                del self._store[key]
            return len(expired_keys)


class RedisStorage:
    """Redis storage for distributed rate limiting."""

    def __init__(self, redis: "AsyncRedis", key_prefix: str = "ratelimit:"):
        if not REDIS_AVAILABLE:
            raise RuntimeError("redis package not installed")
        self._redis = redis
        self._key_prefix = key_prefix

    async def increment(
        self,
        key: str,
        window_seconds: int
    ) -> Tuple[int, int]:
        """
        Increment counter for key using Redis.

        Returns:
            Tuple of (current_count, ttl_seconds).
        """
        full_key = self._key_prefix + key

        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.incr(full_key)
            pipe.ttl(full_key)
            results = await pipe.execute()

        count = results[0]
        ttl = results[1]

        # Set expiration on first request or if TTL is -1 (no expiration)
        if count == 1 or ttl == -1:
            await self._redis.expire(full_key, window_seconds)
            ttl = window_seconds

        return count, max(0, ttl)

    async def get_count(self, key: str) -> int:
        """Get current count for key."""
        full_key = self._key_prefix + key
        count = await self._redis.get(full_key)
        return int(count) if count else 0

    async def reset(self, key: str) -> None:
        """Reset counter for key."""
        full_key = self._key_prefix + key
        await self._redis.delete(full_key)


class RateLimiter:
    """
    Rate limiter supporting in-memory and Redis backends.

    Example:
        # In-memory rate limiter
        limiter = RateLimiter(
            config=RateLimitConfig(window_seconds=60, max_requests=100)
        )

        # Check rate limit
        result = await limiter.check("user:123")
        if not result.allowed:
            raise RateLimitExceeded(result.retry_after, result.limit, result.remaining)

        # With Redis for distributed limiting
        import redis.asyncio as redis
        redis_client = redis.from_url("redis://localhost")
        limiter = RateLimiter(
            config=RateLimitConfig(window_seconds=60, max_requests=100),
            redis=redis_client
        )
    """

    def __init__(
        self,
        config: Optional[RateLimitConfig] = None,
        redis: Optional["AsyncRedis"] = None,
    ):
        self.config = config or RateLimitConfig()

        if redis is not None:
            self._storage = RedisStorage(redis, self.config.key_prefix)
        else:
            self._storage = InMemoryStorage()

    async def check(self, key: str) -> RateLimitResult:
        """
        Check if request should be allowed.

        Args:
            key: Identifier for rate limiting (e.g., user ID, IP address).

        Returns:
            RateLimitResult with allowed status and limit info.
        """
        count, ttl = await self._storage.increment(key, self.config.window_seconds)
        remaining = max(0, self.config.max_requests - count)
        reset_time = int(time.time()) + ttl

        if count > self.config.max_requests:
            return RateLimitResult(
                allowed=False,
                limit=self.config.max_requests,
                remaining=0,
                reset_time=reset_time,
                retry_after=ttl,
            )

        return RateLimitResult(
            allowed=True,
            limit=self.config.max_requests,
            remaining=remaining,
            reset_time=reset_time,
        )

    async def is_allowed(self, key: str) -> bool:
        """Simple check if request is allowed."""
        result = await self.check(key)
        return result.allowed

    async def get_count(self, key: str) -> int:
        """Get current request count for key."""
        return await self._storage.get_count(key)

    async def reset(self, key: str) -> None:
        """Reset rate limit for key."""
        await self._storage.reset(key)

    def add_headers(self, response: Any, result: RateLimitResult) -> Any:
        """
        Add rate limit headers to response.

        Args:
            response: Response object with headers attribute.
            result: Rate limit check result.

        Returns:
            Response with added headers.
        """
        if not self.config.include_headers:
            return response

        response.headers["X-RateLimit-Limit"] = str(result.limit)
        response.headers["X-RateLimit-Remaining"] = str(result.remaining)
        response.headers["X-RateLimit-Reset"] = str(result.reset_time)

        if result.retry_after is not None:
            response.headers["Retry-After"] = str(result.retry_after)

        return response


def rate_limit_decorator(
    limiter: RateLimiter,
    key_func: Callable[..., str],
    on_exceeded: Optional[Callable[[RateLimitResult], Any]] = None,
) -> Callable:
    """
    Decorator factory for rate limiting async functions.

    Args:
        limiter: RateLimiter instance.
        key_func: Function to extract rate limit key from request.
        on_exceeded: Handler for exceeded limits.

    Returns:
        Decorator function.

    Example:
        limiter = RateLimiter()

        def get_user_id(request):
            return f"user:{request.user_id}"

        @rate_limit_decorator(limiter, get_user_id)
        async def my_endpoint(request):
            return {"status": "ok"}
    """
    def decorator(func: Callable) -> Callable:
        async def wrapper(*args, **kwargs):
            # Extract key from first argument (usually request)
            key = key_func(*args, **kwargs)
            result = await limiter.check(key)

            if not result.allowed:
                if on_exceeded:
                    return on_exceeded(result)
                raise RateLimitExceeded(
                    result.retry_after or 0,
                    result.limit,
                    result.remaining,
                )

            return await func(*args, **kwargs)

        return wrapper
    return decorator


__all__ = [
    "RateLimitConfig",
    "RateLimitResult",
    "RateLimitExceeded",
    "RateLimiter",
    "InMemoryStorage",
    "RedisStorage",
    "rate_limit_decorator",
    "REDIS_AVAILABLE",
]
