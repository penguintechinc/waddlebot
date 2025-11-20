"""WaddleBot Router Module (Quart) - Central command routing system"""
import os, sys
from quart import Quart, Blueprint
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from flask_core import setup_aaa_logging, init_database
from config import Config

app = Quart(__name__)
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION, Config.LOG_LEVEL)

# Initialize services
dal = None
command_processor = None
cache_manager = None
rate_limiter = None
session_manager = None

@app.before_serving
async def startup():
    global dal, command_processor, cache_manager, rate_limiter, session_manager
    from services.command_processor import CommandProcessor
    from services.cache_manager import CacheManager
    from services.rate_limiter import RateLimiter
    from services.session_manager import SessionManager

    logger.system("Starting router module", action="startup")

    dal = init_database(Config.DATABASE_URL, pool_size=Config.ROUTER_MAX_WORKERS, read_replica_uri=Config.READ_REPLICA_URL)
    app.config['dal'] = dal

    cache_manager = CacheManager()
    rate_limiter = RateLimiter()
    session_manager = SessionManager()
    command_processor = CommandProcessor(dal, cache_manager, rate_limiter, session_manager)

    app.config['command_processor'] = command_processor
    app.config['cache_manager'] = cache_manager
    app.config['rate_limiter'] = rate_limiter
    app.config['session_manager'] = session_manager

    logger.system("Router module started successfully", result="SUCCESS")

# Register blueprints
from controllers.router import router_bp
from controllers.admin import admin_bp
app.register_blueprint(router_bp, url_prefix='/api/v1/router')
app.register_blueprint(admin_bp, url_prefix='/api/v1/admin')

@app.route('/health')
async def health():
    return {"status": "healthy", "module": Config.MODULE_NAME, "version": Config.MODULE_VERSION}, 200

if __name__ == '__main__':
    import hypercorn.asyncio, asyncio
    from hypercorn.config import Config as HyperConfig
    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
