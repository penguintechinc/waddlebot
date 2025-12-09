"""
Calendar Interaction Module - Complete event management with approval workflow
Supports event CRUD, RSVP, recurring events, platform sync, and multi-community context
"""
import asyncio
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'libs'))

from quart import Blueprint, Quart, request

from config import Config
from flask_core import (
    async_endpoint, auth_required, create_health_blueprint, init_database,
    setup_aaa_logging, success_response, error_response)


app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

calendar_bp = Blueprint('calendar', __name__, url_prefix='/api/v1/calendar')
context_bp = Blueprint('context', __name__, url_prefix='/api/v1/context')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
calendar_service = None
permission_service = None
context_service = None
rsvp_service = None


def get_user_context():
    """Extract user context from request."""
    # In production, this would come from authenticated request
    # For now, extract from headers or request data
    auth_header = request.headers.get('X-User-Context')
    if auth_header:
        import json
        return json.loads(auth_header)

    # Fallback to mock context for testing
    return {
        'user_id': None,
        'username': 'anonymous',
        'platform': 'api',
        'platform_user_id': 'anonymous',
        'role': 'member'
    }


def init_services():
    """Initialize database and services (can be called from startup or tests)."""
    global dal, calendar_service, permission_service, context_service, rsvp_service

    if calendar_service is not None:
        return  # Already initialized

    from services.calendar_service import CalendarService
    from services.permission_service import PermissionService
    from services.context_service import ContextService
    from services.rsvp_service import RSVPService

    logger.system("Starting calendar module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    # Initialize services
    permission_service = PermissionService(dal)
    context_service = ContextService(dal)
    calendar_service = CalendarService(dal, permission_service)
    rsvp_service = RSVPService(dal)

    app.config['calendar_service'] = calendar_service
    app.config['permission_service'] = permission_service
    app.config['context_service'] = context_service
    app.config['rsvp_service'] = rsvp_service

    logger.system("Calendar module started", result="SUCCESS")


@app.before_serving
async def startup():
    """Initialize database and services on app startup."""
    init_services()


# ============================================================================
# EVENT MANAGEMENT ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/events', methods=['GET', 'POST'])
@async_endpoint
async def events(community_id):
    """List or create events."""
    if request.method == 'GET':
        # GET /api/v1/calendar/<community_id>/events
        # Query params: status, date_from, date_to, category_id, tags, entity_id, offset, limit
        filters = {
            'status': request.args.get('status'),
            'date_from': request.args.get('date_from'),
            'date_to': request.args.get('date_to'),
            'category_id': request.args.get('category_id'),
            'entity_id': request.args.get('entity_id'),
            'tags': request.args.getlist('tags')
        }
        # Remove None values
        filters = {k: v for k, v in filters.items() if v is not None}

        pagination = {
            'offset': int(request.args.get('offset', 0)),
            'limit': int(request.args.get('limit', 50))
        }

        event_list = await calendar_service.list_events(
            community_id, filters, pagination
        )
        return success_response({'events': event_list, 'count': len(event_list)})
    else:
        # POST /api/v1/calendar/<community_id>/events
        data = await request.get_json()
        data['community_id'] = community_id
        user_context = get_user_context()

        event = await calendar_service.create_event(data, user_context)
        if event:
            return success_response(event, status_code=201)
        else:
            return error_response("Failed to create event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>', methods=['GET', 'PUT', 'DELETE'])
@async_endpoint
async def event_detail(community_id, event_id):
    """Get, update, or delete event."""
    if request.method == 'GET':
        # GET /api/v1/calendar/<community_id>/events/<event_id>
        include_attendees = request.args.get('include_attendees', 'false').lower() == 'true'
        event = await calendar_service.get_event(event_id, include_attendees)
        if event:
            return success_response(event)
        else:
            return error_response("Event not found", status_code=404)

    elif request.method == 'PUT':
        # PUT /api/v1/calendar/<community_id>/events/<event_id>
        data = await request.get_json()
        user_context = get_user_context()

        event = await calendar_service.update_event(event_id, data, user_context)
        if event:
            return success_response(event)
        else:
            return error_response("Failed to update event", status_code=400)

    else:
        # DELETE /api/v1/calendar/<community_id>/events/<event_id>
        user_context = get_user_context()
        success = await calendar_service.delete_event(event_id, user_context)
        if success:
            return success_response({"message": "Event deleted successfully"})
        else:
            return error_response("Failed to delete event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/approve', methods=['POST'])
@async_endpoint
async def approve_event(community_id, event_id):
    """Approve pending event (admin only)."""
    user_context = get_user_context()
    event = await calendar_service.approve_event(event_id, user_context)
    if event:
        return success_response(event)
    else:
        return error_response("Failed to approve event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/reject', methods=['POST'])
@async_endpoint
async def reject_event(community_id, event_id):
    """Reject pending event with reason (admin only)."""
    data = await request.get_json()
    reason = data.get('reason', 'No reason provided')
    user_context = get_user_context()

    success = await calendar_service.reject_event(event_id, reason, user_context)
    if success:
        return success_response({"message": "Event rejected successfully"})
    else:
        return error_response("Failed to reject event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/cancel', methods=['POST'])
@async_endpoint
async def cancel_event(community_id, event_id):
    """Cancel event (same as delete but explicit)."""
    user_context = get_user_context()
    success = await calendar_service.delete_event(event_id, user_context)
    if success:
        return success_response({"message": "Event cancelled successfully"})
    else:
        return error_response("Failed to cancel event", status_code=400)


# ============================================================================
# RSVP MANAGEMENT ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/events/<int:event_id>/rsvp', methods=['POST', 'PUT', 'DELETE'])
@async_endpoint
async def rsvp(community_id, event_id):
    """Create, update, or cancel RSVP."""
    user_context = get_user_context()

    if request.method in ['POST', 'PUT']:
        # POST/PUT /api/v1/calendar/<community_id>/events/<event_id>/rsvp
        data = await request.get_json()
        rsvp_status = data.get('status', 'yes')  # yes/no/maybe
        guest_count = data.get('guest_count', 0)
        user_note = data.get('note')

        result = await rsvp_service.rsvp_event(
            event_id, user_context, rsvp_status, guest_count, user_note
        )
        if result:
            return success_response(result)
        else:
            return error_response("Failed to RSVP", status_code=400)
    else:
        # DELETE /api/v1/calendar/<community_id>/events/<event_id>/rsvp
        success = await rsvp_service.cancel_rsvp(event_id, user_context)
        if success:
            return success_response({"message": "RSVP cancelled successfully"})
        else:
            return error_response("Failed to cancel RSVP", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/attendees', methods=['GET'])
@async_endpoint
async def attendees(community_id, event_id):
    """Get attendee list."""
    status = request.args.get('status')  # Optional filter: yes/no/maybe
    attendee_list = await rsvp_service.get_attendees(event_id, status)
    return success_response({'attendees': attendee_list, 'count': len(attendee_list)})


# ============================================================================
# SEARCH & DISCOVERY ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/search', methods=['GET'])
@async_endpoint
async def search_events(community_id):
    """Full-text search on events."""
    query = request.args.get('q', '')
    if not query:
        return error_response("Search query required", status_code=400)

    filters = {
        'category_id': request.args.get('category_id'),
        'date_from': request.args.get('date_from'),
        'date_to': request.args.get('date_to')
    }
    filters = {k: v for k, v in filters.items() if v is not None}

    events = await calendar_service.search_events(community_id, query, filters)
    return success_response({'events': events, 'count': len(events), 'query': query})


@calendar_bp.route('/<int:community_id>/upcoming', methods=['GET'])
@async_endpoint
async def upcoming_events(community_id):
    """Get upcoming approved events."""
    limit = int(request.args.get('limit', 10))
    entity_id = request.args.get('entity_id')

    events = await calendar_service.get_upcoming_events(community_id, limit, entity_id)
    return success_response({'events': events, 'count': len(events)})


@calendar_bp.route('/<int:community_id>/trending', methods=['GET'])
@async_endpoint
async def trending_events(community_id):
    """Get trending events (placeholder for Phase 8)."""
    # TODO: Implement trending algorithm in Phase 8
    # For now, return upcoming events as trending
    limit = int(request.args.get('limit', 10))
    events = await calendar_service.get_upcoming_events(community_id, limit)
    return success_response({'events': events, 'count': len(events)})


# ============================================================================
# PLATFORM SYNC ENDPOINTS (Stubs for Phase 4)
# ============================================================================

@calendar_bp.route('/<int:community_id>/sync/enable', methods=['POST'])
@async_endpoint
async def enable_sync(community_id):
    """Enable platform sync (Phase 4 implementation)."""
    # TODO: Implement in Phase 4
    return success_response({"message": "Sync configuration updated (stub)"})


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/sync', methods=['POST'])
@async_endpoint
async def manual_sync(community_id, event_id):
    """Manually trigger sync for event (Phase 4 implementation)."""
    # TODO: Implement in Phase 4
    return success_response({"message": "Manual sync triggered (stub)"})


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/sync/status', methods=['GET'])
@async_endpoint
async def sync_status(community_id, event_id):
    """Get sync status for event."""
    event = await calendar_service.get_event(event_id)
    if event:
        return success_response(event.get('sync', {}))
    else:
        return error_response("Event not found", status_code=404)


@calendar_bp.route('/webhooks/discord', methods=['POST'])
@async_endpoint
async def discord_webhook():
    """Handle Discord scheduled event webhooks (Phase 4 implementation)."""
    # TODO: Implement in Phase 4
    data = await request.get_json()
    logger.info(f"Discord webhook received: {data.get('type')}")
    return success_response({"message": "Webhook received (stub)"})


@calendar_bp.route('/webhooks/twitch', methods=['POST'])
@async_endpoint
async def twitch_webhook():
    """Handle Twitch schedule webhooks (Phase 4 implementation)."""
    # TODO: Implement in Phase 4
    data = await request.get_json()
    logger.info(f"Twitch webhook received: {data.get('type')}")
    return success_response({"message": "Webhook received (stub)"})


# ============================================================================
# CONFIGURATION ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/config/permissions', methods=['GET', 'PUT'])
@async_endpoint
async def permissions_config(community_id):
    """Get or update permissions configuration."""
    if request.method == 'GET':
        permissions = await permission_service.get_permissions(community_id)
        if permissions:
            return success_response(permissions)
        else:
            return error_response("Permissions not found", status_code=404)
    else:
        # PUT - update permissions (admin only)
        data = await request.get_json()
        user_context = get_user_context()

        success = await permission_service.update_permissions(
            community_id, data, user_context
        )
        if success:
            return success_response({"message": "Permissions updated successfully"})
        else:
            return error_response("Failed to update permissions", status_code=400)


@calendar_bp.route('/<int:community_id>/config/reminders', methods=['GET', 'PUT'])
@async_endpoint
async def reminders_config(community_id):
    """Get or update reminder configuration (Phase 5 implementation)."""
    # TODO: Implement in Phase 5
    if request.method == 'GET':
        return success_response({
            "allow_15min": True,
            "allow_1hour": True,
            "allow_24hour": True,
            "allow_1week": True,
            "default_1hour": True,
            "default_24hour": True
        })
    else:
        return success_response({"message": "Reminder config updated (stub)"})


@calendar_bp.route('/<int:community_id>/categories', methods=['GET', 'POST'])
@async_endpoint
async def categories(community_id):
    """List or create event categories."""
    if request.method == 'GET':
        # Query categories from database
        query = """
            SELECT id, name, description, color, icon, display_order, is_active
            FROM calendar_categories
            WHERE community_id = $1 AND is_active = TRUE
            ORDER BY display_order ASC
        """
        rows = await dal.execute(query, [community_id])

        category_list = []
        for row in rows:
            category_list.append({
                'id': row['id'],
                'name': row['name'],
                'description': row['description'],
                'color': row['color'],
                'icon': row['icon'],
                'display_order': row['display_order']
            })

        return success_response({'categories': category_list, 'count': len(category_list)})
    else:
        # POST - create new category (admin only)
        data = await request.get_json()
        user_context = get_user_context()

        # Check admin permission
        if user_context.get('role') not in ['admin', 'super_admin']:
            return error_response("Admin permission required", status_code=403)

        query = """
            INSERT INTO calendar_categories (
                community_id, name, description, color, icon, display_order
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, name
        """
        result = await dal.execute(query, [
            community_id,
            data.get('name'),
            data.get('description'),
            data.get('color'),
            data.get('icon'),
            data.get('display_order', 100)
        ])

        if result:
            return success_response(
                {'id': result[0]['id'], 'name': result[0]['name']},
                status_code=201
            )
        else:
            return error_response("Failed to create category", status_code=400)


# ============================================================================
# CONTEXT MANAGEMENT ENDPOINTS
# ============================================================================

@context_bp.route('/<entity_id>', methods=['GET'])
@async_endpoint
async def get_context(entity_id):
    """Get current community context for entity."""
    user_id = request.args.get('user_id', 'anonymous')
    context = await context_service.get_current_context(user_id, entity_id)

    if context:
        return success_response({'current_community_id': context})
    else:
        return success_response({'current_community_id': None})


@context_bp.route('/<entity_id>/switch', methods=['POST'])
@async_endpoint
async def switch_context(entity_id):
    """Switch active community context."""
    data = await request.get_json()
    user_id = data.get('user_id', 'anonymous')
    community_name = data.get('community_name')

    if not community_name:
        return error_response("community_name required", status_code=400)

    success = await context_service.switch_context(user_id, entity_id, community_name)
    if success:
        return success_response({"message": f"Switched to community: {community_name}"})
    else:
        return error_response("Failed to switch context", status_code=400)


@context_bp.route('/<entity_id>/available', methods=['GET'])
@async_endpoint
async def available_communities(entity_id):
    """Get list of available communities for entity."""
    communities = await context_service.get_available_communities(entity_id)
    return success_response({'communities': communities, 'count': len(communities)})


# Register blueprints
app.register_blueprint(calendar_bp)
app.register_blueprint(context_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
