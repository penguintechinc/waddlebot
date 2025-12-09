"""
Shoutout Interaction Module

Generates platform-aware shoutouts with Twitch API integration.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from quart import Blueprint, Quart, request  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint,
    auth_required,
    create_health_blueprint,
    init_database,
    setup_aaa_logging,
    success_response,
    error_response,
)
from config import Config  # noqa: E402
from services.twitch_service import TwitchService  # noqa: E402
from services.shoutout_service import ShoutoutService  # noqa: E402

app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
twitch_service = None
shoutout_service = None


@app.before_serving
async def startup():
    global dal, twitch_service, shoutout_service
    logger.system("Starting shoutout_interaction_module", action="startup")

    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    # Initialize Twitch service
    twitch_service = TwitchService(
        client_id=Config.TWITCH_CLIENT_ID,
        client_secret=Config.TWITCH_CLIENT_SECRET
    )

    # Initialize shoutout service
    shoutout_service = ShoutoutService(dal)

    logger.system("shoutout_interaction_module started", result="SUCCESS")


@api_bp.route('/status')
@async_endpoint
async def status():
    """Module status endpoint"""
    return success_response({
        "status": "operational",
        "module": Config.MODULE_NAME,
        "version": Config.MODULE_VERSION
    })


@api_bp.route('/shoutout', methods=['POST'])
@async_endpoint
async def create_shoutout():
    """
    Generate shoutout for a Twitch user.

    Request JSON:
    {
        "username": "target_username",
        "community_id": 123,
        "platform": "twitch"
    }

    Returns shoutout message and metadata.
    """
    try:
        data = await request.get_json()

        username = data.get('username')
        community_id = data.get('community_id')
        platform = data.get('platform', 'twitch')

        if not username:
            return error_response("username is required", status_code=400)

        if not community_id:
            return error_response("community_id is required", status_code=400)

        logger.audit(
            action="create_shoutout",
            community=community_id,
            target_user=username,
            result="STARTED"
        )

        # Get Twitch data
        twitch_data = await twitch_service.get_full_shoutout_data(username)

        if not twitch_data:
            return error_response(
                f"User '{username}' not found on Twitch",
                status_code=404
            )

        # Generate shoutout
        shoutout = await shoutout_service.generate_shoutout(
            twitch_data,
            community_id,
            platform
        )

        logger.audit(
            action="create_shoutout",
            community=community_id,
            target_user=username,
            result="SUCCESS"
        )

        return success_response(shoutout)

    except Exception as e:
        logger.error(f"Failed to create shoutout: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/history/<int:community_id>', methods=['GET'])
@auth_required
@async_endpoint
async def get_history(community_id: int):
    """
    Get shoutout history for community.

    Query params:
    - limit: Number of results (default 50)
    """
    try:
        limit = int(request.args.get('limit', 50))
        history = await shoutout_service.get_shoutout_history(
            community_id,
            limit
        )

        return success_response({
            'history': history,
            'count': len(history)
        })

    except Exception as e:
        logger.error(f"Failed to get history: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/stats/<int:community_id>', methods=['GET'])
@auth_required
@async_endpoint
async def get_stats(community_id: int):
    """Get shoutout statistics for community"""
    try:
        stats = await shoutout_service.get_stats(community_id)
        return success_response(stats)

    except Exception as e:
        logger.error(f"Failed to get stats: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/template', methods=['POST'])
@auth_required
@async_endpoint
async def save_template():
    """
    Save custom shoutout template.

    Request JSON:
    {
        "community_id": 123,
        "platform": "twitch",
        "is_live": true,
        "template": "Check out {display_name} at twitch.tv/{login}!"
    }

    Template variables:
    - {display_name} - User display name
    - {login} - Username
    - {game_name} - Current/last game
    - {title} - Stream title
    - {viewer_count} - Viewer count (live only)
    - {description} - User description
    """
    try:
        data = await request.get_json()

        community_id = data.get('community_id')
        platform = data.get('platform', 'twitch')
        is_live = data.get('is_live', True)
        template = data.get('template')

        if not all([community_id, template]):
            return error_response(
                "community_id and template are required",
                status_code=400
            )

        success = await shoutout_service.save_custom_template(
            community_id,
            platform,
            is_live,
            template
        )

        if success:
            logger.audit(
                action="save_template",
                community=community_id,
                result="SUCCESS"
            )
            return success_response({"message": "Template saved"})
        else:
            return error_response("Failed to save template", status_code=500)

    except Exception as e:
        logger.error(f"Failed to save template: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/twitch/user/<username>', methods=['GET'])
@auth_required
@async_endpoint
async def get_twitch_user(username: str):
    """
    Get Twitch user information.

    For testing/debugging Twitch API integration.
    """
    try:
        data = await twitch_service.get_full_shoutout_data(username)

        if not data:
            return error_response("User not found", status_code=404)

        return success_response(data)

    except Exception as e:
        logger.error(f"Failed to get Twitch user: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/circuit-breaker/metrics', methods=['GET'])
@auth_required
@async_endpoint
async def circuit_breaker_metrics():
    """Get circuit breaker metrics for Twitch API"""
    try:
        metrics = twitch_service.get_circuit_breaker_metrics()
        return success_response(metrics)

    except Exception as e:
        logger.error(f"Failed to get metrics: {e}")
        return error_response(str(e), status_code=500)


app.register_blueprint(api_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig
    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
