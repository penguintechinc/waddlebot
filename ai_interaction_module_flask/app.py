"""
WaddleBot AI Interaction Module (Quart)
========================================

AI-powered chat interactions with multiple provider support:
- Ollama: Direct connection with configurable host:port and TLS
- WaddleAI: Centralized proxy for OpenAI, Claude, MCP, and other providers

Converted from py4web to Quart for better async performance.
"""

import os
import sys
from quart import Quart, Blueprint, request, jsonify
import asyncio
import logging
from datetime import datetime

# Add libs to path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))

from flask_core import (
    setup_aaa_logging,
    async_endpoint,
    auth_required,
    success_response,
    error_response,
    init_database
)

from config import Config
from services.ai_service import AIService
from services.router_service import RouterService

# Initialize Quart app
app = Quart(__name__)
ai_bp = Blueprint('ai', __name__, url_prefix='/api/v1/ai')

# Setup logging
logger = setup_aaa_logging(
    module_name=Config.MODULE_NAME,
    version=Config.MODULE_VERSION,
    log_level=Config.LOG_LEVEL
)

# Initialize services
ai_service = None
router_service = None


@app.before_serving
async def startup():
    """Initialize services on startup"""
    global ai_service, router_service

    logger.system("Starting AI interaction module", action="startup")

    try:
        # Initialize AI service
        ai_service = AIService.create()
        logger.system(f"Initialized AI service with provider: {Config.AI_PROVIDER}")

        # Initialize router service
        router_service = RouterService()
        logger.system("Initialized router service")

        # Health check
        is_healthy = await ai_service.health_check()
        if is_healthy:
            logger.system("AI provider health check passed", result="SUCCESS")
        else:
            logger.error("AI provider health check failed", result="FAILED")

    except Exception as e:
        logger.error(f"Startup failed: {e}", action="startup", result="ERROR")
        raise


@app.after_serving
async def shutdown():
    """Cleanup on shutdown"""
    logger.system("Shutting down AI interaction module", action="shutdown")


# Health check endpoint (no auth required)
@app.route('/health', methods=['GET'])
async def health():
    """Health check for container orchestration"""
    try:
        is_healthy = await ai_service.health_check()

        if is_healthy:
            return success_response({
                "status": "healthy",
                "module": Config.MODULE_NAME,
                "version": Config.MODULE_VERSION,
                "provider": Config.AI_PROVIDER,
                "connection": "connected"
            })
        else:
            return error_response(
                "AI provider connection failed",
                status_code=503,
                details={"provider": Config.AI_PROVIDER}
            )

    except Exception as e:
        logger.error(f"Health check error: {e}")
        return error_response(str(e), status_code=503)


# Module info endpoint
@app.route('/', methods=['GET'])
@app.route('/index', methods=['GET'])
async def index():
    """Module information and status"""
    return success_response({
        "module": Config.MODULE_NAME,
        "version": Config.MODULE_VERSION,
        "provider": Config.AI_PROVIDER,
        "model": Config.AI_MODEL,
        "status": "operational",
        "endpoints": [
            "/health",
            "/api/v1/ai/interaction",
            "/api/v1/ai/chat/completions",
            "/api/v1/ai/models",
            "/api/v1/ai/config",
            "/api/v1/ai/test"
        ]
    })


# Main interaction endpoint
@ai_bp.route('/interaction', methods=['POST'])
@async_endpoint
async def interaction():
    """
    Main interaction endpoint for processing messages and events.

    Expected JSON:
    {
        "session_id": "sess_123",
        "message_type": "chatMessage",
        "message_content": "Hello!",
        "user_id": "user123",
        "entity_id": "twitch:channel:456",
        "platform": "twitch",
        "username": "john_doe",
        "display_name": "John Doe"
    }
    """
    try:
        data = await request.get_json()

        # Validate required fields
        session_id = data.get('session_id')
        if not session_id:
            return error_response("session_id is required", status_code=400)

        message_type = data.get('message_type', 'chatMessage')
        message_content = data.get('message_content', '')
        user_id = data.get('user_id')
        entity_id = data.get('entity_id')
        platform = data.get('platform')
        username = data.get('username', user_id)

        logger.audit(
            action="process_interaction",
            user=username,
            community=entity_id,
            result="STARTED",
            message_type=message_type
        )

        # Process interaction asynchronously (don't wait for result)
        asyncio.create_task(
            process_interaction(
                session_id, message_type, message_content,
                user_id, entity_id, platform, username, data
            )
        )

        # Return immediate response
        return success_response({
            "message": "Processing request",
            "session_id": session_id
        })

    except Exception as e:
        logger.error(f"Interaction endpoint error: {e}")
        return error_response(str(e), status_code=500)


async def process_interaction(
    session_id: str,
    message_type: str,
    message_content: str,
    user_id: str,
    entity_id: str,
    platform: str,
    username: str,
    full_data: dict
):
    """Process interaction asynchronously"""
    start_time = datetime.utcnow()

    try:
        # Determine if we should respond
        should_respond = False
        response_context = {}

        if message_type == 'chatMessage':
            # Check for greeting patterns
            greeting_patterns = ['o7', 'hi', 'hello', 'hey', 'howdy', 'greetings', 'sup', 'hiya']
            farewell_patterns = ['!lurk', 'bye', 'goodbye', 'later', 'cya']

            message_lower = message_content.lower().strip()

            # Check greetings
            for pattern in greeting_patterns:
                if pattern in message_lower:
                    should_respond = True
                    response_context['trigger_type'] = 'greeting'
                    response_context['trigger'] = pattern
                    break

            # Check farewells
            if not should_respond:
                for pattern in farewell_patterns:
                    if pattern in message_lower:
                        should_respond = True
                        response_context['trigger_type'] = 'farewell'
                        response_context['trigger'] = pattern
                        break

            # Check question triggers
            if not should_respond:
                for trigger in Config.QUESTION_TRIGGERS:
                    if trigger in message_content:
                        should_respond = True
                        response_context['trigger_type'] = 'question'
                        response_context['trigger'] = trigger
                        break

        elif message_type in Config.EVENT_RESPONSE_TYPES and Config.RESPOND_TO_EVENTS:
            should_respond = True
            response_context['trigger_type'] = 'event'
            response_context['event_type'] = message_type

        if not should_respond:
            logger.audit(
                action="process_interaction",
                user=username,
                community=entity_id,
                result="NO_RESPONSE_NEEDED",
                message_type=message_type
            )
            return

        # Generate AI response
        ai_response = await ai_service.generate_response(
            message_content=message_content,
            message_type=message_type,
            user_id=user_id,
            platform=platform,
            context=response_context
        )

        # Calculate processing time
        processing_time = int((datetime.utcnow() - start_time).total_seconds() * 1000)

        if ai_response:
            # Send response back to router
            response_data = {
                "session_id": session_id,
                "module_name": Config.MODULE_NAME,
                "success": True,
                "response_action": "chat",
                "response_data": {
                    "message": f"{Config.RESPONSE_PREFIX}{ai_response}"
                },
                "processing_time_ms": processing_time
            }

            await router_service.submit_response(response_data)

            logger.audit(
                action="process_interaction",
                user=username,
                community=entity_id,
                result="SUCCESS",
                execution_time=processing_time
            )
        else:
            logger.error(
                f"No AI response generated",
                user=username,
                community=entity_id,
                action="generate_response"
            )

    except Exception as e:
        logger.error(
            f"Error processing interaction: {e}",
            user=username,
            community=entity_id,
            action="process_interaction"
        )

        # Send error response to router
        error_response_data = {
            "session_id": session_id,
            "module_name": Config.MODULE_NAME,
            "success": False,
            "error_message": str(e),
            "processing_time_ms": int((datetime.utcnow() - start_time).total_seconds() * 1000)
        }

        try:
            await router_service.submit_response(error_response_data)
        except Exception as submit_error:
            logger.error(f"Failed to submit error response: {submit_error}")


# OpenAI-compatible chat completions endpoint
@ai_bp.route('/chat/completions', methods=['POST'])
@auth_required
@async_endpoint
async def chat_completions():
    """
    OpenAI-compatible chat completions endpoint.

    Compatible with OpenAI API format for easy integration.
    """
    try:
        data = await request.get_json()

        messages = data.get('messages', [])
        model = data.get('model', Config.AI_MODEL)
        temperature = data.get('temperature', Config.AI_TEMPERATURE)
        max_tokens = data.get('max_tokens', Config.AI_MAX_TOKENS)

        if not messages:
            return error_response("messages array is required", status_code=400)

        # Extract last user message
        user_message = ""
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                user_message = msg.get('content', '')
                break

        # Build context from messages
        context = {
            'conversation_history': messages[:-1] if len(messages) > 1 else [],
            'trigger_type': 'api_request'
        }

        # Generate response
        ai_response = await ai_service.generate_response(
            message_content=user_message,
            message_type='chatMessage',
            user_id=request.current_user['user_id'],
            platform='api',
            context=context
        )

        if ai_response:
            # OpenAI-compatible response format
            return success_response({
                "id": f"chatcmpl-{session_id}",
                "object": "chat.completion",
                "created": int(datetime.utcnow().timestamp()),
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": ai_response
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": len(user_message.split()),
                    "completion_tokens": len(ai_response.split()),
                    "total_tokens": len(user_message.split()) + len(ai_response.split())
                }
            })
        else:
            return error_response("Failed to generate response", status_code=500)

    except Exception as e:
        logger.error(f"Chat completions error: {e}")
        return error_response(str(e), status_code=500)


# Get available models
@ai_bp.route('/models', methods=['GET'])
@async_endpoint
async def get_models():
    """Get list of available AI models"""
    try:
        models = await ai_service.get_available_models()

        return success_response({
            "provider": Config.AI_PROVIDER,
            "models": models,
            "current_model": Config.AI_MODEL
        })

    except Exception as e:
        logger.error(f"Get models error: {e}")
        return error_response(str(e), status_code=500)


# Get/Update configuration
@ai_bp.route('/config', methods=['GET', 'PUT'])
@auth_required
@async_endpoint
async def config():
    """Get or update AI module configuration"""
    try:
        if request.method == 'GET':
            # Return current configuration
            return success_response({
                "provider": Config.AI_PROVIDER,
                "model": Config.AI_MODEL,
                "temperature": Config.AI_TEMPERATURE,
                "max_tokens": Config.AI_MAX_TOKENS,
                "system_prompt": Config.SYSTEM_PROMPT,
                "question_triggers": Config.QUESTION_TRIGGERS,
                "respond_to_events": Config.RESPOND_TO_EVENTS,
                "event_response_types": Config.EVENT_RESPONSE_TYPES
            })

        else:  # PUT
            data = await request.get_json()

            # Update configuration
            if 'model' in data:
                Config.AI_MODEL = data['model']
            if 'temperature' in data:
                Config.AI_TEMPERATURE = float(data['temperature'])
            if 'max_tokens' in data:
                Config.AI_MAX_TOKENS = int(data['max_tokens'])
            if 'system_prompt' in data:
                Config.SYSTEM_PROMPT = data['system_prompt']
            if 'question_triggers' in data:
                Config.QUESTION_TRIGGERS = data['question_triggers']
            if 'respond_to_events' in data:
                Config.RESPOND_TO_EVENTS = bool(data['respond_to_events'])
            if 'event_response_types' in data:
                Config.EVENT_RESPONSE_TYPES = data['event_response_types']

            logger.audit(
                action="update_config",
                user=request.current_user['username'],
                community="system",
                result="SUCCESS"
            )

            return success_response({
                "message": "Configuration updated successfully",
                "config": {
                    "provider": Config.AI_PROVIDER,
                    "model": Config.AI_MODEL,
                    "temperature": Config.AI_TEMPERATURE,
                    "max_tokens": Config.AI_MAX_TOKENS
                }
            })

    except Exception as e:
        logger.error(f"Config endpoint error: {e}")
        return error_response(str(e), status_code=500)


# Test endpoint
@ai_bp.route('/test', methods=['POST'])
@auth_required
@async_endpoint
async def test():
    """Test AI generation with custom input"""
    try:
        data = await request.get_json()
        test_message = data.get('message', 'What is the weather like?')

        response_text = await ai_service.generate_response(
            message_content=test_message,
            message_type='chatMessage',
            user_id=request.current_user['user_id'],
            platform='test',
            context={'trigger_type': 'test'}
        )

        return success_response({
            "input": test_message,
            "output": response_text,
            "provider": Config.AI_PROVIDER,
            "model": Config.AI_MODEL
        })

    except Exception as e:
        logger.error(f"Test endpoint error: {e}")
        return error_response(str(e), status_code=500)


# Register blueprint
app.register_blueprint(ai_bp)


if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
