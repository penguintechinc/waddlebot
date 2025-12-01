"""Browser source for OBS - Quart Application."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'libs'))  # noqa: E402

from quart import Blueprint, Quart  # noqa: E402

from config import Config  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint, create_health_blueprint, init_database,
    setup_aaa_logging, success_response)


app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None


@app.before_serving
async def startup():
    """Initialize database and start module."""
    global dal
    logger.system("Starting browser_source_core_module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
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

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
