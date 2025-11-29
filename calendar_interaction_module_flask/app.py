"""Calendar Interaction Module - Event management with approval workflow."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'libs'))  # noqa: E402

from quart import Blueprint, Quart, request  # noqa: E402

from config import Config  # noqa: E402
from flask_core import (  # noqa: E402
    async_endpoint, auth_required, create_health_blueprint, init_database,
    setup_aaa_logging, success_response)


app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

calendar_bp = Blueprint('calendar', __name__, url_prefix='/api/v1/calendar')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
calendar_service = None


@app.before_serving
async def startup():
    """Initialize database and calendar service."""
    global dal, calendar_service
    from services.calendar_service import CalendarService

    logger.system("Starting calendar module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal
    calendar_service = CalendarService(dal)
    app.config['calendar_service'] = calendar_service
    logger.system("Calendar module started", result="SUCCESS")


@calendar_bp.route('/events', methods=['GET', 'POST'])
@async_endpoint
async def events():
    """List or create events."""
    if request.method == 'GET':
        community_id = request.args.get('community_id')
        status = request.args.get('status', 'approved')
        event_list = await calendar_service.list_events(community_id, status)
        return success_response(event_list)
    else:
        data = await request.get_json()
        event = await calendar_service.create_event(data)
        return success_response(event, status_code=201)


@calendar_bp.route('/events/<event_id>', methods=['GET', 'PUT', 'DELETE'])
@async_endpoint
async def event_detail(event_id):
    """Get, update, or delete event."""
    if request.method == 'GET':
        event = await calendar_service.get_event(event_id)
        return success_response(event)
    elif request.method == 'PUT':
        data = await request.get_json()
        event = await calendar_service.update_event(event_id, data)
        return success_response(event)
    else:
        await calendar_service.delete_event(event_id)
        return success_response({"message": "Event deleted"})


@calendar_bp.route('/events/<event_id>/approve', methods=['POST'])
@auth_required
@async_endpoint
async def approve_event(event_id):
    """Approve pending event."""
    approved_by = request.current_user['username']
    event = await calendar_service.approve_event(event_id, approved_by)
    return success_response(event)


@calendar_bp.route('/events/<event_id>/join', methods=['POST'])
@async_endpoint
async def join_event(event_id):
    """Join event as attendee."""
    data = await request.get_json()
    user_id = data.get('user_id')
    await calendar_service.join_event(event_id, user_id)
    return success_response({"message": "Joined event"})

app.register_blueprint(calendar_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
