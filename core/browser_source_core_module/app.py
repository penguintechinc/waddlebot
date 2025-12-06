"""Browser source for OBS - Quart Application."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'libs'))  # noqa: E402

from quart import Blueprint, Quart, request  # noqa: E402

from config import Config  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint, create_health_blueprint, init_database,
    setup_aaa_logging, success_response)
from services.overlay_service import OverlayService  # noqa: E402


app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
overlay_service = None


@app.before_serving
async def startup():
    """Initialize database and start module."""
    global dal, overlay_service
    logger.system("Starting browser_source_core_module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
    overlay_service = OverlayService(dal)
    logger.system("browser_source_core_module started", result="SUCCESS")


@api_bp.route('/status')
@async_endpoint
async def status():
    """Return module status."""
    response_data = {
        "status": "operational",
        "module": Config.MODULE_NAME
    }
    return success_response(response_data)

app.register_blueprint(api_bp)

overlay_bp = Blueprint('overlay', __name__, url_prefix='/overlay')


@overlay_bp.route('/<overlay_key>')
@async_endpoint
async def serve_overlay(overlay_key: str):
    """
    Serve unified overlay for a community.
    URL format: /overlay/<64-char-hex-key>
    """
    global overlay_service

    # Get client info for logging
    ip_address = request.headers.get('X-Forwarded-For', request.remote_addr)
    user_agent = request.headers.get('User-Agent', '')

    # Validate overlay key
    result = await overlay_service.validate_overlay_key(overlay_key)

    if not result:
        # Log invalid access attempt
        await overlay_service.log_access(
            community_id=0,
            overlay_key=overlay_key[:64] if overlay_key else '',
            ip_address=ip_address,
            user_agent=user_agent,
            was_valid=False
        )
        return '<html><body><h1>Invalid overlay key</h1></body></html>', 404

    # Log valid access
    await overlay_service.log_access(
        community_id=result['community_id'],
        overlay_key=overlay_key,
        ip_address=ip_address,
        user_agent=user_agent,
        source_types=result['enabled_sources'],
        was_valid=True
    )

    # Generate and return overlay HTML
    html = await overlay_service.get_overlay_html(
        community_id=result['community_id'],
        theme_config=result['theme_config'],
        enabled_sources=result['enabled_sources']
    )

    return html, 200, {
        'Content-Type': 'text/html',
        'X-Frame-Options': 'ALLOWALL',  # Required for OBS browser source
        'Cache-Control': 'no-cache'
    }


app.register_blueprint(overlay_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
