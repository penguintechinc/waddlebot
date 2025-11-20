"""
YouTube Music integration - Quart Application
"""
import os, sys
from quart import Quart, Blueprint, request
from datetime import datetime
import asyncio

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))
from flask_core import setup_aaa_logging, init_database, async_endpoint, success_response, error_response
from config import Config

app = Quart(__name__)
api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None

@app.before_serving
async def startup():
    global dal
    logger.system("Starting youtube_music_interaction_module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
    logger.system("youtube_music_interaction_module started", result="SUCCESS")

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
