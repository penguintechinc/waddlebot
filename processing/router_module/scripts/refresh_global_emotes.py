#!/usr/bin/env python3
"""
Daily Global Emotes Refresh Script
===================================

This script should be run by a cron job once per day to refresh
global emotes from all platforms (Twitch, BTTV, FFZ, 7TV, etc.)

Cron example (run at 3 AM daily):
    0 3 * * * cd /app && python3 scripts/refresh_global_emotes.py >> /var/log/emote_refresh.log 2>&1

Or via Kubernetes CronJob.
"""

import asyncio
import logging
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import Config

# Setup logging
logging.basicConfig(
    level=getattr(logging, Config.LOG_LEVEL, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def main():
    """Run the global emotes refresh."""
    logger.info("=" * 60)
    logger.info("Starting daily global emotes refresh")
    logger.info("=" * 60)

    try:
        # Initialize database and cache connections
        from dal import DAL
        from services.cache_manager import CacheManager
        from services.emote_service import EmoteService

        # Initialize DAL
        dal = DAL(Config.DATABASE_URL)

        # Initialize cache manager
        cache_manager = CacheManager(
            host=Config.REDIS_HOST,
            port=Config.REDIS_PORT,
            password=Config.REDIS_PASSWORD,
            db=Config.REDIS_DB
        )

        # Initialize emote service
        emote_service = EmoteService(dal, cache_manager)

        # Run the refresh
        results = await emote_service.refresh_global_emotes_cron()

        # Log results
        total_emotes = sum(results.values())
        logger.info(f"Refresh complete. Total emotes cached: {total_emotes}")

        for platform, count in results.items():
            logger.info(f"  - {platform}: {count} emotes")

        # Get and log stats
        stats = await emote_service.get_stats()
        logger.info(f"Cache stats: {stats}")

        return 0

    except Exception as e:
        logger.error(f"Global emotes refresh failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
