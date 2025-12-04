"""
Twitch collector - Quart Application
"""
import asyncio
import os
import sys

from quart import Blueprint, Quart

# Setup path for shared libraries
sys.path.insert(0,
                os.path.join(os.path.dirname(os.path.dirname(__file__)),
                             'libs'))

from flask_core import (async_endpoint, create_health_blueprint,  # noqa: E402
                        init_database, setup_aaa_logging,
                        success_response)
from config import Config  # noqa: E402
from services.viewer_tracker import ViewerTracker  # noqa: E402

app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
viewer_tracker = None


async def _load_tracked_channels(dal) -> dict:
    """Load Twitch channels to track from database"""
    channels = {}
    try:
        # Query servers table for active Twitch channels with community mapping
        result = dal.executesql(
            """SELECT s.platform_server_id, s.platform_data, cs.community_id
               FROM servers s
               JOIN community_servers cs ON cs.platform_server_id = s.platform_server_id
               WHERE s.platform = 'twitch' AND s.is_active = true AND cs.is_active = true
            """
        )
        for row in result:
            channel_id = row[0]
            platform_data = row[1] or {}
            community_id = row[2]

            # Extract broadcaster_id from platform_data JSON
            broadcaster_id = ''
            if isinstance(platform_data, dict):
                broadcaster_id = platform_data.get('broadcaster_id', '')

            channels[channel_id] = {
                'broadcaster_id': broadcaster_id,
                'community_id': community_id,
            }
        logger.info(f"Loaded {len(channels)} Twitch channels for viewer tracking")
    except Exception as e:
        logger.warning(f"Failed to load tracked channels: {e}")
    return channels


@app.before_serving
async def startup():
    global dal, viewer_tracker
    logger.system("Starting twitch_module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    # Initialize viewer tracker if enabled
    if Config.VIEWER_TRACKING_ENABLED and Config.HUB_API_URL and Config.SERVICE_API_KEY:
        viewer_tracker = ViewerTracker(
            hub_api_url=Config.HUB_API_URL,
            service_api_key=Config.SERVICE_API_KEY,
            twitch_client_id=Config.TWITCH_CLIENT_ID,
            twitch_access_token=Config.TWITCH_ACCESS_TOKEN,
            poll_interval=Config.VIEWER_POLL_INTERVAL,
        )
        channels = await _load_tracked_channels(dal)
        if channels:
            await viewer_tracker.start(channels)
            logger.system("Viewer tracker started", result="SUCCESS")
        else:
            logger.info("No channels to track - viewer tracker not started")
    else:
        logger.info("Viewer tracking disabled or missing configuration")

    logger.system("twitch_module started", result="SUCCESS")


@app.after_serving
async def shutdown():
    global viewer_tracker
    logger.system("Shutting down twitch_module", action="shutdown")
    if viewer_tracker:
        await viewer_tracker.stop()
        logger.system("Viewer tracker stopped", result="SUCCESS")
    logger.system("twitch_module shutdown complete", result="SUCCESS")


@api_bp.route('/status')
@async_endpoint
async def status():
    return success_response({
        "status": "operational",
        "module": Config.MODULE_NAME
    })

app.register_blueprint(api_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig
    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
