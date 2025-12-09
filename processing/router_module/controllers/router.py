"""Router Controller - Main routing endpoints"""
import asyncio

from quart import Blueprint, request, current_app
from flask_core import async_endpoint, success_response
from flask_core.validation import validate_json

from validation_models import (
    RouterEventRequest,
    RouterBatchRequest,
    RouterResponseRequest
)

router_bp = Blueprint('router', __name__)


@router_bp.route('/events', methods=['POST'])
@validate_json(RouterEventRequest)
@async_endpoint
async def process_event(validated_data: RouterEventRequest):
    """Process single event"""
    processor = current_app.config['command_processor']
    result = await processor.process_event(validated_data.dict())
    return success_response(result)


@router_bp.route('/events/batch', methods=['POST'])
@validate_json(RouterBatchRequest)
@async_endpoint
async def process_events_batch(validated_data: RouterBatchRequest):
    """Process up to 100 events concurrently"""
    processor = current_app.config['command_processor']
    events_list = [event.dict() for event in validated_data.events]
    results = await asyncio.gather(*[processor.process_event(e) for e in events_list])
    return success_response({"results": results, "count": len(results)})


@router_bp.route('/commands', methods=['GET'])
@async_endpoint
async def list_commands():
    """List available commands"""
    processor = current_app.config['command_processor']
    commands = await processor.list_commands()
    return success_response(commands)


@router_bp.route('/responses', methods=['POST'])
@validate_json(RouterResponseRequest)
@async_endpoint
async def submit_response(validated_data: RouterResponseRequest):
    """Receive response from interaction module"""
    processor = current_app.config['command_processor']
    await processor.handle_module_response(validated_data.dict())
    return success_response({"message": "Response received"})


@router_bp.route('/metrics', methods=['GET'])
@async_endpoint
async def get_metrics():
    """Get performance metrics"""
    processor = current_app.config['command_processor']
    metrics = await processor.get_metrics()
    return success_response(metrics)
