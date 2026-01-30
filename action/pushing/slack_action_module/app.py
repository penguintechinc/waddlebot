"""
Slack Action Module - Main Application
Flask/Quart application with gRPC server for receiving tasks from processor
and REST API for third-party use
"""
import asyncio
import logging
import sys
from typing import Optional

from quart import Quart, request, jsonify
from pydal import DAL
import jwt
from functools import wraps

from config import Config
from services.slack_service import SlackService
from services.grpc_handler import create_grpc_server


# Configure logging
logging.basicConfig(
    level=getattr(logging, Config.LOG_LEVEL),
    format='[%(asctime)s] %(levelname)s %(name)s: %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(f'{Config.LOG_DIR}/slack_action.log') if Config.LOG_DIR else logging.NullHandler()
    ]
)

logger = logging.getLogger(__name__)

# Initialize Quart app
app = Quart(__name__)
app.config.from_object(Config)

# Initialize database
# Use fake_migrate=True to check schema without trying to create tables
db = DAL(
    Config.DATABASE_URL,
    folder='/tmp/pydal',
    pool_size=10,
    migrate_enabled=False,
    fake_migrate_all=True
)

# Initialize Slack service
slack_service = SlackService(
    bot_token=Config.SLACK_BOT_TOKEN,
    db=db
)

# gRPC server instance
grpc_server = None


def require_auth(f):
    """JWT authentication decorator for REST API"""
    @wraps(f)
    async def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization')

        if not auth_header:
            return jsonify({'error': 'No authorization header'}), 401

        try:
            # Extract token from "Bearer <token>"
            scheme, token = auth_header.split()
            if scheme.lower() != 'bearer':
                return jsonify({'error': 'Invalid authorization scheme'}), 401

            # Verify JWT
            payload = jwt.decode(
                token,
                Config.MODULE_SECRET_KEY,
                algorithms=[Config.JWT_ALGORITHM]
            )

            # Add payload to request context
            request.jwt_payload = payload

        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401
        except ValueError:
            return jsonify({'error': 'Invalid authorization header format'}), 401

        return await f(*args, **kwargs)

    return decorated_function


# ============================================================================
# REST API Endpoints
# ============================================================================

@app.route('/health', methods=['GET'])
async def health_check():
    """Health check endpoint"""
    try:
        # Check database connectivity
        db.executesql('SELECT 1')

        return jsonify({
            'status': 'healthy',
            'module': Config.MODULE_NAME,
            'version': Config.MODULE_VERSION,
            'grpc_port': Config.GRPC_PORT,
            'rest_port': Config.REST_PORT
        }), 200

    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify({
            'status': 'unhealthy',
            'error': str(e)
        }), 503


@app.route('/api/v1/message', methods=['POST'])
@require_auth
async def send_message_api():
    """REST API endpoint for sending messages"""
    try:
        data = await request.get_json()

        result = await slack_service.send_message(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            text=data.get('text'),
            blocks=data.get('blocks'),
            thread_ts=data.get('thread_ts')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Send message API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/ephemeral', methods=['POST'])
@require_auth
async def send_ephemeral_api():
    """REST API endpoint for sending ephemeral messages"""
    try:
        data = await request.get_json()

        result = await slack_service.send_ephemeral(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            user_id=data.get('user_id'),
            text=data.get('text')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Send ephemeral API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/message/<string:channel_id>/<string:ts>', methods=['PUT'])
@require_auth
async def update_message_api(channel_id: str, ts: str):
    """REST API endpoint for updating messages"""
    try:
        data = await request.get_json()

        result = await slack_service.update_message(
            community_id=data.get('community_id'),
            channel_id=channel_id,
            ts=ts,
            text=data.get('text'),
            blocks=data.get('blocks')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Update message API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/message/<string:channel_id>/<string:ts>', methods=['DELETE'])
@require_auth
async def delete_message_api(channel_id: str, ts: str):
    """REST API endpoint for deleting messages"""
    try:
        data = await request.get_json()

        result = await slack_service.delete_message(
            community_id=data.get('community_id'),
            channel_id=channel_id,
            ts=ts
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Delete message API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/reaction', methods=['POST'])
@require_auth
async def add_reaction_api():
    """REST API endpoint for adding reactions"""
    try:
        data = await request.get_json()

        result = await slack_service.add_reaction(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            ts=data.get('ts'),
            emoji=data.get('emoji')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Add reaction API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/reaction', methods=['DELETE'])
@require_auth
async def remove_reaction_api():
    """REST API endpoint for removing reactions"""
    try:
        data = await request.get_json()

        result = await slack_service.remove_reaction(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            ts=data.get('ts'),
            emoji=data.get('emoji')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Remove reaction API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/file', methods=['POST'])
@require_auth
async def upload_file_api():
    """REST API endpoint for uploading files"""
    try:
        data = await request.get_json()

        # Decode base64 file content if provided
        import base64
        file_content = base64.b64decode(data.get('file_content_base64', ''))

        result = await slack_service.upload_file(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            file_content=file_content,
            filename=data.get('filename'),
            title=data.get('title')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Upload file API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/channel', methods=['POST'])
@require_auth
async def create_channel_api():
    """REST API endpoint for creating channels"""
    try:
        data = await request.get_json()

        result = await slack_service.create_channel(
            community_id=data.get('community_id'),
            name=data.get('name'),
            is_private=data.get('is_private', False)
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Create channel API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/channel/invite', methods=['POST'])
@require_auth
async def invite_to_channel_api():
    """REST API endpoint for inviting users to channels"""
    try:
        data = await request.get_json()

        result = await slack_service.invite_to_channel(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            user_ids=data.get('user_ids', [])
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Invite to channel API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/channel/kick', methods=['POST'])
@require_auth
async def kick_from_channel_api():
    """REST API endpoint for removing users from channels"""
    try:
        data = await request.get_json()

        result = await slack_service.kick_from_channel(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            user_id=data.get('user_id')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Kick from channel API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/channel/topic', methods=['PUT'])
@require_auth
async def set_topic_api():
    """REST API endpoint for setting channel topics"""
    try:
        data = await request.get_json()

        result = await slack_service.set_topic(
            community_id=data.get('community_id'),
            channel_id=data.get('channel_id'),
            topic=data.get('topic')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Set topic API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/modal', methods=['POST'])
@require_auth
async def open_modal_api():
    """REST API endpoint for opening modals"""
    try:
        data = await request.get_json()

        result = await slack_service.open_modal(
            community_id=data.get('community_id'),
            trigger_id=data.get('trigger_id'),
            view=data.get('view')
        )

        return jsonify(result), 200 if result['success'] else 500

    except Exception as e:
        logger.error(f"Open modal API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/history/<string:community_id>', methods=['GET'])
@require_auth
async def get_action_history_api(community_id: str):
    """REST API endpoint for getting action history"""
    try:
        limit = request.args.get('limit', 100, type=int)

        history = await slack_service.get_action_history(
            community_id=community_id,
            limit=limit
        )

        return jsonify({'history': history}), 200

    except Exception as e:
        logger.error(f"Get history API error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/v1/token', methods=['POST'])
async def generate_token():
    """Generate JWT token for API authentication"""
    try:
        data = await request.get_json()

        # In production, verify credentials against database
        api_key = data.get('api_key')
        if api_key != Config.MODULE_SECRET_KEY:
            return jsonify({'error': 'Invalid API key'}), 401

        # Generate JWT token
        import time
        payload = {
            'exp': int(time.time()) + Config.JWT_EXPIRY_SECONDS,
            'iat': int(time.time()),
            'sub': data.get('client_id', 'default')
        }

        token = jwt.encode(
            payload,
            Config.MODULE_SECRET_KEY,
            algorithm=Config.JWT_ALGORITHM
        )

        return jsonify({
            'token': token,
            'expires_in': Config.JWT_EXPIRY_SECONDS
        }), 200

    except Exception as e:
        logger.error(f"Token generation error: {e}")
        return jsonify({'error': str(e)}), 500


# ============================================================================
# Application Lifecycle
# ============================================================================

@app.before_serving
async def startup():
    """Application startup"""
    global grpc_server

    logger.info("Starting Slack Action Module...")

    # Validate configuration
    errors = Config.validate()
    if errors:
        logger.error(f"Configuration errors: {', '.join(errors)}")
        sys.exit(1)

    logger.info(f"Configuration: {Config.get_info()}")

    # Start gRPC server
    grpc_server = create_grpc_server(
        slack_service=slack_service,
        port=Config.GRPC_PORT,
        max_workers=Config.GRPC_MAX_WORKERS
    )

    if grpc_server:
        await grpc_server.start()
        logger.info(f"gRPC server started on port {Config.GRPC_PORT}")
    else:
        logger.warning("gRPC server not started - proto files may not be generated")

    logger.info(f"REST API started on port {Config.REST_PORT}")


@app.after_serving
async def shutdown():
    """Application shutdown"""
    global grpc_server

    logger.info("Shutting down Slack Action Module...")

    # Stop gRPC server
    if grpc_server:
        await grpc_server.stop(grace=5)
        logger.info("gRPC server stopped")

    # Close database connections
    db.close()
    logger.info("Database connections closed")


if __name__ == '__main__':
    # Run with Hypercorn in production
    # hypercorn app:app --bind 0.0.0.0:8071 --workers 4
    app.run(
        host='0.0.0.0',
        port=Config.REST_PORT,
        debug=False
    )
