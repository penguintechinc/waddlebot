"""
Community Hub Module - The epicenter for WaddleBot communities.

A web application providing public and authenticated access to community
data across Discord, Twitch, and Slack platforms.
"""
import asyncio
import os
import sys

from quart import Quart, g, request

# Add libs to path for flask_core
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from flask_core import (  # noqa: E402
    create_health_blueprint,
    init_database,
    setup_aaa_logging,
)

from config import Config  # noqa: E402

# Create Quart application
app = Quart(__name__, static_folder='static', template_folder='templates')
app.secret_key = Config.SECRET_KEY

# Initialize logging
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

# Register health endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

# Database connection
dal = None


@app.before_serving
async def startup():
    """Initialize database and services on startup."""
    global dal
    logger.system("Starting community_hub_module", action="startup")

    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    from pydal import Field

    # Reference tables from other modules (migrate=False - we're only reading)
    # Communities table (owned by identity_core_module)
    dal.define_table(
        'communities',
        Field('name', 'string', length=255),
        Field('display_name', 'string', length=255),
        Field('description', 'text'),
        Field('logo_url', 'string', length=500),
        Field('banner_url', 'string', length=500),
        Field('primary_platform', 'string', length=50),
        Field('owner_id', 'integer'),
        Field('is_public', 'boolean', default=True),
        Field('is_active', 'boolean', default=True),
        Field('member_count', 'integer', default=0),
        Field('settings', 'json'),
        Field('created_at', 'datetime'),
        Field('updated_at', 'datetime'),
        migrate=False,
    )

    # Coordination table (owned by router_module)
    dal.define_table(
        'coordination',
        Field('platform', 'string', length=50),
        Field('server_id', 'string', length=100),
        Field('channel_id', 'string', length=100),
        Field('entity_id', 'string', length=200),
        Field('community_id', 'integer'),
        Field('claimed_by', 'string', length=100),
        Field('claimed_at', 'datetime'),
        Field('status', 'string', length=20),
        Field('is_live', 'boolean', default=False),
        Field('live_since', 'datetime'),
        Field('viewer_count', 'integer', default=0),
        Field('stream_title', 'string', length=500),
        Field('game_name', 'string', length=255),
        Field('thumbnail_url', 'string', length=500),
        Field('last_activity', 'datetime'),
        Field('last_check', 'datetime'),
        Field('last_checkin', 'datetime'),
        Field('claim_expires', 'datetime'),
        Field('heartbeat_interval', 'integer', default=300),
        Field('error_count', 'integer', default=0),
        Field('metadata', 'json'),
        Field('priority', 'integer', default=0),
        Field('max_containers', 'integer', default=1),
        Field('config', 'json'),
        Field('created_at', 'datetime'),
        Field('updated_at', 'datetime'),
        migrate=False,
    )

    # Community members table (owned by identity_core_module)
    dal.define_table(
        'community_members',
        Field('community_id', 'integer'),
        Field('user_id', 'integer'),
        Field('display_name', 'string', length=255),
        Field('role', 'string', length=50, default='member'),
        Field('reputation_score', 'integer', default=0),
        Field('joined_at', 'datetime'),
        Field('last_active', 'datetime'),
        Field('is_active', 'boolean', default=True),
        migrate=False,
    )

    # Community activity table (owned by reputation_module)
    dal.define_table(
        'community_activity',
        Field('community_id', 'integer'),
        Field('user_id', 'integer'),
        Field('user_name', 'string', length=255),
        Field('platform', 'string', length=50),
        Field('event_type', 'string', length=50),
        Field('points', 'integer', default=0),
        Field('details', 'json'),
        Field('created_at', 'datetime'),
        migrate=False,
    )

    # Entity groups table (owned by labels_core_module)
    dal.define_table(
        'entity_groups',
        Field('community_id', 'integer'),
        Field('name', 'string', length=255),
        Field('platform', 'string', length=50),
        Field('entity_ids', 'list:string'),
        Field('is_active', 'boolean', default=True),
        Field('created_at', 'datetime'),
        Field('updated_at', 'datetime'),
        migrate=False,
    )

    # Community domains table (owned by this module)
    dal.define_table(
        'community_domains',
        Field('community_id', 'integer', required=True),
        Field('domain', 'string', length=255, unique=True, required=True),
        Field('domain_type', 'string', length=20, required=True),
        Field('is_primary', 'boolean', default=False),
        Field('is_verified', 'boolean', default=False),
        Field('verification_token', 'string', length=64),
        Field('created_at', 'datetime'),
        Field('updated_at', 'datetime'),
    )

    # Hub sessions table (owned by this module)
    dal.define_table(
        'hub_sessions',
        Field('session_token', 'string', length=255, unique=True),
        Field('user_id', 'integer'),
        Field('platform', 'string', length=50),
        Field('platform_user_id', 'string', length=100),
        Field('platform_username', 'string', length=255),
        Field('avatar_url', 'string', length=500),
        Field('created_at', 'datetime'),
        Field('expires_at', 'datetime'),
        Field('is_active', 'boolean', default=True),
    )

    logger.system("community_hub_module started", result="SUCCESS")


@app.before_request
async def resolve_community_domain():
    """Middleware to resolve community from Host header."""
    host = request.host.lower()

    # Skip for health endpoints
    if request.path in ['/health', '/metrics', '/ready']:
        return

    # Remove port if present
    if ':' in host:
        host = host.split(':')[0]

    # Check if this is a custom domain or subdomain
    g.community = None
    g.domain_info = None

    if dal is None:
        return

    # Look up domain in community_domains table
    try:
        domain_row = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: dal.dal(dal.dal.community_domains.domain == host).select().first()
        )

        if domain_row and domain_row.is_verified:
            # Found verified domain, load community
            community_row = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: dal.dal(dal.dal.communities.id == domain_row.community_id).select().first()
            )
            if community_row:
                g.community = community_row
                g.domain_info = domain_row
    except Exception as e:
        logger.error(f"Domain resolution error: {e}")


@app.after_serving
async def shutdown():
    """Clean up on shutdown."""
    global dal
    logger.system("Shutting down community_hub_module", action="shutdown")
    if dal:
        await dal.close_async()
    logger.system("community_hub_module stopped", result="SUCCESS")


# Import and register blueprints
from controllers.public import public_bp  # noqa: E402
from controllers.auth import auth_bp  # noqa: E402
from controllers.authenticated import authenticated_bp  # noqa: E402
from controllers.api import api_bp  # noqa: E402

app.register_blueprint(public_bp)
app.register_blueprint(auth_bp, url_prefix='/auth')
app.register_blueprint(authenticated_bp)
app.register_blueprint(api_bp, url_prefix='/api/v1')


if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
