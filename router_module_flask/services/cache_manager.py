"""Cache Manager - Redis caching"""
import redis.asyncio as redis
from config import Config

class CacheManager:
    def __init__(self):
        self.redis = redis.Redis(host=Config.REDIS_HOST, port=Config.REDIS_PORT, password=Config.REDIS_PASSWORD, db=Config.REDIS_DB, decode_responses=True)

    async def get(self, key: str):
        return await self.redis.get(key)

    async def set(self, key: str, value: str, ttl: int = 300):
        await self.redis.setex(key, ttl, value)

    async def delete(self, key: str):
        await self.redis.delete(key)
