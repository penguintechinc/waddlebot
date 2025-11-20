"""Router Controller - Main routing endpoints"""
from quart import Blueprint, request, current_app
from flask_core import async_endpoint, success_response, error_response
import asyncio

router_bp = Blueprint('router', __name__)

@router_bp.route('/events', methods=['POST'])
@async_endpoint
async def process_event():
    """Process single event"""
    data = await request.get_json()
    processor = current_app.config['command_processor']
    result = await processor.process_event(data)
    return success_response(result)

@router_bp.route('/events/batch', methods=['POST'])
@async_endpoint
async def process_events_batch():
    """Process up to 100 events concurrently"""
    events = await request.get_json()
    processor = current_app.config['command_processor']
    results = await asyncio.gather(*[processor.process_event(e) for e in events[:100]])
    return success_response({"results": results, "count": len(results)})

@router_bp.route('/commands', methods=['GET'])
@async_endpoint
async def list_commands():
    """List available commands"""
    processor = current_app.config['command_processor']
    commands = await processor.list_commands()
    return success_response(commands)

@router_bp.route('/responses', methods=['POST'])
@async_endpoint
async def submit_response():
    """Receive response from interaction module"""
    data = await request.get_json()
    processor = current_app.config['command_processor']
    await processor.handle_module_response(data)
    return success_response({"message": "Response received"})

@router_bp.route('/metrics', methods=['GET'])
@async_endpoint
async def get_metrics():
    """Get performance metrics"""
    processor = current_app.config['command_processor']
    metrics = await processor.get_metrics()
    return success_response(metrics)
