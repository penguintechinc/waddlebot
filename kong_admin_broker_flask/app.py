"""
Kong admin broker - Quart Application
"""
import asyncio
import os
import sys

from quart import Blueprint, Quart

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from config import Config  # noqa: E402
from flask_core import async_endpoint, init_database, setup_aaa_logging, success_response  # noqa: E402

app = Quart(__name__)
api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None


@app.before_serving
async def startup():
    global dal
    logger.system("Starting kong_admin_broker", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
    logger.system("kong_admin_broker started", result="SUCCESS")


@app.route('/health')
async def health():
    return {"status": "healthy", "module": Config.MODULE_NAME, "version": Config.MODULE_VERSION}, 200


@api_bp.route('/status')
@async_endpoint
async def status():
    return success_response({"status": "operational", "module": Config.MODULE_NAME})

app.register_blueprint(api_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig
    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
