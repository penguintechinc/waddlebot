"""
Calendar Interaction Module - Complete event management with approval workflow
Supports event CRUD, RSVP, recurring events, platform sync, and multi-community context
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                'libs'))

from quart import Blueprint, Quart, request

from config import Config
from flask_core import (
    async_endpoint, create_health_blueprint, init_database,
    setup_aaa_logging, success_response, error_response)
from flask_core.validation import validate_json, validate_query

from validation_models import (
    EventCreateRequest, EventSearchParams, EventUpdateRequest,
    EventApprovalRequest, RSVPRequest, AttendeeSearchParams,
    EventFullTextSearchParams, UpcomingEventsParams,
    PermissionsConfigRequest, CategoryCreateRequest,
    ContextSwitchRequest,
    # Ticketing models
    TicketTypeCreateRequest, TicketTypeUpdateRequest,
    TicketCreateRequest, TicketVerifyRequest, TicketCheckInRequest,
    TicketUndoCheckInRequest, TicketTransferRequest,
    TicketSearchParams, CheckInLogParams, TicketingConfigRequest,
    # Event admin models
    EventAdminAssignRequest, EventAdminUpdateRequest
)


app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

calendar_bp = Blueprint('calendar', __name__, url_prefix='/api/v1/calendar')
context_bp = Blueprint('context', __name__, url_prefix='/api/v1/context')
ticket_bp = Blueprint('ticket', __name__, url_prefix='/api/v1/calendar')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
calendar_service = None
permission_service = None
context_service = None
rsvp_service = None
ticket_service = None
event_admin_service = None


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
    global dal, calendar_service, permission_service, context_service, rsvp_service, ticket_service, event_admin_service

    if calendar_service is not None:
        return  # Already initialized

    from services.calendar_service import CalendarService
    from services.permission_service import PermissionService
    from services.context_service import ContextService
    from services.rsvp_service import RSVPService
    from services.ticket_service import TicketService
    from services.event_admin_service import EventAdminService

    logger.system("Starting calendar module", action="startup")
    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    # Initialize services
    # Note: Order matters - ticket_service must be created before rsvp_service
    # so RSVP can auto-generate tickets on confirmation
    permission_service = PermissionService(dal)
    context_service = ContextService(dal)
    calendar_service = CalendarService(dal, permission_service)
    event_admin_service = EventAdminService(dal, permission_service)
    ticket_service = TicketService(dal, permission_service)
    rsvp_service = RSVPService(dal, ticket_service=ticket_service)

    app.config['calendar_service'] = calendar_service
    app.config['permission_service'] = permission_service
    app.config['context_service'] = context_service
    app.config['rsvp_service'] = rsvp_service
    app.config['ticket_service'] = ticket_service
    app.config['event_admin_service'] = event_admin_service

    logger.system("Calendar module started", result="SUCCESS")


@app.before_serving
async def startup():
    """Initialize database and services on app startup."""
    init_services()


# ============================================================================
# EVENT MANAGEMENT ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/events', methods=['GET'])
@async_endpoint
@validate_query(EventSearchParams)
async def list_events(community_id, query_params: EventSearchParams):
    """
    List events with validated query parameters.

    CRITICAL FIX: Uses Pydantic validation to prevent 500 errors from
    unsafe int() conversions on lines 116-117 of original code.
    """
    # Build filters from validated query params
    filters = {}
    if query_params.status:
        filters['status'] = query_params.status
    if query_params.date_from:
        filters['date_from'] = query_params.date_from.isoformat()
    if query_params.date_to:
        filters['date_to'] = query_params.date_to.isoformat()
    if query_params.category_id:
        filters['category_id'] = query_params.category_id
    if query_params.entity_id:
        filters['entity_id'] = query_params.entity_id
    if query_params.tags:
        filters['tags'] = query_params.tags
    if query_params.platform:
        filters['platform'] = query_params.platform

    pagination = {
        'offset': query_params.offset,
        'limit': query_params.limit
    }

    event_list = await calendar_service.list_events(
        community_id, filters, pagination
    )
    return success_response({'events': event_list, 'count': len(event_list)})


@calendar_bp.route('/<int:community_id>/events', methods=['POST'])
@async_endpoint
@validate_json(EventCreateRequest)
async def create_event(validated_data: EventCreateRequest, community_id):
    """Create new event with validated data."""
    # Override community_id from path parameter
    event_data = validated_data.dict()
    event_data['community_id'] = community_id
    user_context = get_user_context()

    event = await calendar_service.create_event(event_data, user_context)
    if event:
        return success_response(event, status_code=201)
    else:
        return error_response("Failed to create event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>', methods=['GET'])
@async_endpoint
async def get_event(community_id, event_id):
    """Get event details."""
    include_attendees = request.args.get('include_attendees', 'false').lower() == 'true'
    event = await calendar_service.get_event(event_id, include_attendees)
    if event:
        return success_response(event)
    else:
        return error_response("Event not found", status_code=404)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>', methods=['PUT'])
@async_endpoint
@validate_json(EventUpdateRequest)
async def update_event(validated_data: EventUpdateRequest, community_id, event_id):
    """Update event with validated data."""
    user_context = get_user_context()
    event_data = validated_data.dict(exclude_unset=True)  # Only include fields that were set

    event = await calendar_service.update_event(event_id, event_data, user_context)
    if event:
        return success_response(event)
    else:
        return error_response("Failed to update event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>', methods=['DELETE'])
@async_endpoint
async def delete_event(community_id, event_id):
    """Delete event."""
    user_context = get_user_context()
    success = await calendar_service.delete_event(event_id, user_context)
    if success:
        return success_response({"message": "Event deleted successfully"})
    else:
        return error_response("Failed to delete event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/approve', methods=['POST'])
@async_endpoint
@validate_json(EventApprovalRequest)
async def approve_event(validated_data: EventApprovalRequest, community_id, event_id):
    """
    Approve or reject pending event with validated data (admin only).

    Unified endpoint for both approval and rejection actions.
    """
    user_context = get_user_context()

    if validated_data.status == 'approved':
        event = await calendar_service.approve_event(event_id, user_context)
        if event:
            return success_response(event)
        else:
            return error_response("Failed to approve event", status_code=400)
    else:
        # rejected
        reason = validated_data.notes or validated_data.reason or 'No reason provided'
        success = await calendar_service.reject_event(event_id, reason, user_context)
        if success:
            return success_response({"message": "Event rejected successfully"})
        else:
            return error_response("Failed to reject event", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/reject', methods=['POST'])
@async_endpoint
@validate_json(EventApprovalRequest)
async def reject_event(validated_data: EventApprovalRequest, community_id, event_id):
    """
    Reject pending event with reason (admin only).

    Deprecated: Use /approve endpoint with status='rejected' instead.
    """
    user_context = get_user_context()
    reason = validated_data.notes or validated_data.reason or 'No reason provided'

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

@calendar_bp.route('/<int:community_id>/events/<int:event_id>/rsvp', methods=['POST', 'PUT'])
@async_endpoint
@validate_json(RSVPRequest)
async def create_or_update_rsvp(validated_data: RSVPRequest, community_id, event_id):
    """Create or update RSVP with validated data."""
    user_context = get_user_context()

    result = await rsvp_service.rsvp_event(
        event_id, user_context,
        validated_data.status,
        validated_data.guest_count,
        validated_data.note
    )
    if result:
        return success_response(result)
    else:
        return error_response("Failed to RSVP", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/rsvp', methods=['DELETE'])
@async_endpoint
async def cancel_rsvp(community_id, event_id):
    """Cancel RSVP."""
    user_context = get_user_context()
    success = await rsvp_service.cancel_rsvp(event_id, user_context)
    if success:
        return success_response({"message": "RSVP cancelled successfully"})
    else:
        return error_response("Failed to cancel RSVP", status_code=400)


@calendar_bp.route('/<int:community_id>/events/<int:event_id>/attendees', methods=['GET'])
@async_endpoint
@validate_query(AttendeeSearchParams)
async def get_attendees(query_params: AttendeeSearchParams, community_id, event_id):
    """Get attendee list with optional filtering."""
    attendee_list = await rsvp_service.get_attendees(event_id, query_params.status)
    return success_response({'attendees': attendee_list, 'count': len(attendee_list)})


# ============================================================================
# SEARCH & DISCOVERY ENDPOINTS
# ============================================================================

@calendar_bp.route('/<int:community_id>/search', methods=['GET'])
@async_endpoint
@validate_query(EventFullTextSearchParams)
async def search_events(query_params: EventFullTextSearchParams, community_id):
    """Full-text search on events with validated parameters."""
    filters = {}
    if query_params.category_id:
        filters['category_id'] = query_params.category_id
    if query_params.date_from:
        filters['date_from'] = query_params.date_from.isoformat()
    if query_params.date_to:
        filters['date_to'] = query_params.date_to.isoformat()

    events = await calendar_service.search_events(community_id, query_params.q, filters)
    return success_response({'events': events, 'count': len(events), 'query': query_params.q})


@calendar_bp.route('/<int:community_id>/upcoming', methods=['GET'])
@async_endpoint
@validate_query(UpcomingEventsParams)
async def upcoming_events(query_params: UpcomingEventsParams, community_id):
    """Get upcoming approved events with validated parameters."""
    events = await calendar_service.get_upcoming_events(
        community_id, query_params.limit, query_params.entity_id
    )
    return success_response({'events': events, 'count': len(events)})


@calendar_bp.route('/<int:community_id>/trending', methods=['GET'])
@async_endpoint
@validate_query(UpcomingEventsParams)
async def trending_events(query_params: UpcomingEventsParams, community_id):
    """
    Get trending events (placeholder for Phase 8).

    CRITICAL FIX: Uses validated parameters to prevent int() conversion errors.
    """
    # TODO: Implement trending algorithm in Phase 8
    # For now, return upcoming events as trending
    events = await calendar_service.get_upcoming_events(community_id, query_params.limit)
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

@calendar_bp.route('/<int:community_id>/config/permissions', methods=['GET'])
@async_endpoint
async def get_permissions_config(community_id):
    """Get permissions configuration."""
    permissions = await permission_service.get_permissions(community_id)
    if permissions:
        return success_response(permissions)
    else:
        return error_response("Permissions not found", status_code=404)


@calendar_bp.route('/<int:community_id>/config/permissions', methods=['PUT'])
@async_endpoint
@validate_json(PermissionsConfigRequest)
async def update_permissions_config(validated_data: PermissionsConfigRequest, community_id):
    """Update permissions configuration with validated data (admin only)."""
    user_context = get_user_context()
    permissions_data = validated_data.dict(exclude_unset=True)

    success = await permission_service.update_permissions(
        community_id, permissions_data, user_context
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


@calendar_bp.route('/<int:community_id>/categories', methods=['GET'])
@async_endpoint
async def list_categories(community_id):
    """List event categories."""
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


@calendar_bp.route('/<int:community_id>/categories', methods=['POST'])
@async_endpoint
@validate_json(CategoryCreateRequest)
async def create_category(validated_data: CategoryCreateRequest, community_id):
    """Create new event category with validated data (admin only)."""
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
        validated_data.name,
        validated_data.description,
        validated_data.color,
        validated_data.icon,
        validated_data.display_order
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
@validate_json(ContextSwitchRequest)
async def switch_context(validated_data: ContextSwitchRequest, entity_id):
    """Switch active community context with validated data."""
    success = await context_service.switch_context(
        validated_data.user_id, entity_id, validated_data.community_name
    )
    if success:
        return success_response({"message": f"Switched to community: {validated_data.community_name}"})
    else:
        return error_response("Failed to switch context", status_code=400)


@context_bp.route('/<entity_id>/available', methods=['GET'])
@async_endpoint
async def available_communities(entity_id):
    """Get list of available communities for entity."""
    communities = await context_service.get_available_communities(entity_id)
    return success_response({'communities': communities, 'count': len(communities)})


# ============================================================================
# TICKETING ENDPOINTS
# ============================================================================

@ticket_bp.route('/verify-ticket', methods=['POST'])
@async_endpoint
@validate_json(TicketVerifyRequest)
async def verify_ticket(validated_data: TicketVerifyRequest):
    """
    Verify and optionally check-in a ticket via QR code.
    This is the main endpoint called by QR scanners.
    """
    from services.ticket_service import CheckInMethod

    user_context = get_user_context()

    result = await ticket_service.verify_ticket(
        ticket_code=validated_data.ticket_code,
        perform_checkin=validated_data.perform_checkin,
        operator_context=user_context,
        check_in_method=CheckInMethod.QR_SCAN,
        location=validated_data.location,
        ip_address=request.remote_addr,
        user_agent=request.headers.get('User-Agent')
    )

    if result.success:
        return success_response({
            'valid': True,
            'result': result.result_code.value,
            'ticket': result.ticket,
            'event': result.event_info,
            'message': result.message
        })
    else:
        return success_response({
            'valid': False,
            'result': result.result_code.value,
            'ticket': result.ticket,
            'message': result.message
        })


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticket-types', methods=['GET'])
@async_endpoint
async def list_ticket_types(community_id, event_id):
    """List ticket types for an event."""
    types = await ticket_service.list_ticket_types(event_id)
    return success_response({'ticket_types': types, 'count': len(types)})


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticket-types', methods=['POST'])
@async_endpoint
@validate_json(TicketTypeCreateRequest)
async def create_ticket_type(validated_data: TicketTypeCreateRequest, community_id, event_id):
    """Create a new ticket type for an event."""
    user_context = get_user_context()

    # Check permission (event admin with manage_ticket_types or community admin)
    can_manage = await event_admin_service.has_permission(
        event_id, user_context,
        event_admin_service.EventAdminPermission.MANAGE_TICKET_TYPES
    ) if event_admin_service else True

    if not can_manage:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict()
    ticket_type = await ticket_service.create_ticket_type(
        event_id=event_id,
        name=data['name'],
        description=data.get('description'),
        max_quantity=data.get('max_quantity'),
        price_cents=data.get('price_cents', 0),
        currency=data.get('currency', 'USD'),
        sales_start=data.get('sales_start'),
        sales_end=data.get('sales_end'),
        display_order=data.get('display_order', 0)
    )

    if ticket_type:
        return success_response(ticket_type, status_code=201)
    else:
        return error_response("Failed to create ticket type", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticket-types/<int:type_id>', methods=['PUT'])
@async_endpoint
@validate_json(TicketTypeUpdateRequest)
async def update_ticket_type(validated_data: TicketTypeUpdateRequest, community_id, event_id, type_id):
    """Update a ticket type (admin/event admin)."""
    user_context = get_user_context()

    # Check permission
    can_manage = await event_admin_service.can_manage_ticket_types(
        event_id, user_context
    ) if event_admin_service else True

    if not can_manage:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict(exclude_unset=True)
    ticket_type = await ticket_service.update_ticket_type(
        ticket_type_id=type_id,
        user_context=user_context,
        **data
    )

    if ticket_type:
        return success_response(ticket_type)
    else:
        return error_response("Failed to update ticket type", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticket-types/<int:type_id>', methods=['DELETE'])
@async_endpoint
async def delete_ticket_type(community_id, event_id, type_id):
    """Delete a ticket type (admin/event admin)."""
    user_context = get_user_context()

    # Check permission
    can_manage = await event_admin_service.can_manage_ticket_types(
        event_id, user_context
    ) if event_admin_service else True

    if not can_manage:
        return error_response("Permission denied", status_code=403)

    success = await ticket_service.delete_ticket_type(
        ticket_type_id=type_id,
        user_context=user_context
    )

    if success:
        return success_response({"deleted": True})
    else:
        return error_response("Failed to delete ticket type or type has existing tickets", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticketing/enable', methods=['POST'])
@async_endpoint
@validate_json(TicketingConfigRequest)
async def enable_ticketing(validated_data: TicketingConfigRequest, community_id, event_id):
    """Enable ticketing for an event (admin/event admin)."""
    user_context = get_user_context()

    # Check permission
    can_configure = await event_admin_service.can_configure_ticketing(
        event_id, user_context
    ) if event_admin_service else True

    if not can_configure:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict(exclude_unset=True)
    config = await ticket_service.enable_ticketing(
        event_id=event_id,
        user_context=user_context,
        **data
    )

    if config:
        return success_response(config)
    else:
        return error_response("Failed to enable ticketing", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/ticketing/disable', methods=['POST'])
@async_endpoint
async def disable_ticketing(community_id, event_id):
    """Disable ticketing for an event (admin/event admin)."""
    user_context = get_user_context()

    # Check permission
    can_configure = await event_admin_service.can_configure_ticketing(
        event_id, user_context
    ) if event_admin_service else True

    if not can_configure:
        return error_response("Permission denied", status_code=403)

    success = await ticket_service.disable_ticketing(
        event_id=event_id,
        user_context=user_context
    )

    if success:
        return success_response({"ticketing_enabled": False})
    else:
        return error_response("Failed to disable ticketing", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/tickets', methods=['GET'])
@async_endpoint
@validate_query(TicketSearchParams)
async def list_tickets(community_id, event_id, query_params: TicketSearchParams):
    """List tickets for an event (admin/event admin only)."""
    user_context = get_user_context()

    # Check permission
    can_view = await event_admin_service.can_view_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_view:
        return error_response("Permission denied", status_code=403)

    result = await ticket_service.list_tickets(
        event_id=event_id,
        status=query_params.status,
        is_checked_in=query_params.is_checked_in,
        ticket_type_id=query_params.ticket_type_id,
        search=query_params.search,
        limit=query_params.limit,
        offset=query_params.offset
    )
    return success_response(result)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/tickets', methods=['POST'])
@async_endpoint
@validate_json(TicketCreateRequest)
async def create_ticket(validated_data: TicketCreateRequest, community_id, event_id):
    """Create a ticket manually (admin/event admin)."""
    user_context = get_user_context()

    # Check permission
    can_view = await event_admin_service.can_view_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_view:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict()
    ticket_user_context = {
        'user_id': data.get('hub_user_id'),
        'platform': data['platform'],
        'platform_user_id': data['platform_user_id'],
        'username': data['username']
    }

    ticket = await ticket_service.create_ticket(
        event_id=event_id,
        user_context=ticket_user_context,
        ticket_type_id=data.get('ticket_type_id'),
        holder_name=data.get('holder_name'),
        holder_email=data.get('holder_email')
    )

    if ticket:
        return success_response(ticket, status_code=201)
    else:
        return error_response("Failed to create ticket", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/check-in', methods=['POST'])
@async_endpoint
@validate_json(TicketCheckInRequest)
async def check_in_ticket(validated_data: TicketCheckInRequest, community_id, event_id):
    """Check in a ticket manually."""
    from services.ticket_service import CheckInMethod

    user_context = get_user_context()

    # Check permission
    can_check_in = await event_admin_service.can_check_in(
        event_id, user_context
    ) if event_admin_service else True

    if not can_check_in:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict()

    if data.get('ticket_code'):
        result = await ticket_service.verify_ticket(
            ticket_code=data['ticket_code'],
            perform_checkin=True,
            operator_context=user_context,
            check_in_method=CheckInMethod.MANUAL,
            location=data.get('location'),
            ip_address=request.remote_addr
        )
    else:
        return error_response("ticket_code required for check-in", status_code=400)

    if result.success:
        return success_response({
            'checked_in': True,
            'ticket': result.ticket,
            'message': result.message
        })
    else:
        return success_response({
            'checked_in': False,
            'result': result.result_code.value,
            'message': result.message
        })


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/check-in/undo', methods=['POST'])
@async_endpoint
@validate_json(TicketUndoCheckInRequest)
async def undo_check_in(validated_data: TicketUndoCheckInRequest, community_id, event_id):
    """Undo a ticket check-in."""
    user_context = get_user_context()

    # Check permission
    can_check_in = await event_admin_service.can_check_in(
        event_id, user_context
    ) if event_admin_service else True

    if not can_check_in:
        return error_response("Permission denied", status_code=403)

    success = await ticket_service.undo_check_in(
        ticket_id=validated_data.ticket_id,
        operator_context=user_context,
        reason=validated_data.reason
    )

    if success:
        return success_response({'message': 'Check-in undone successfully'})
    else:
        return error_response("Failed to undo check-in", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/attendance', methods=['GET'])
@async_endpoint
async def get_attendance_stats(community_id, event_id):
    """Get attendance statistics for an event."""
    user_context = get_user_context()

    # Check permission
    can_view = await event_admin_service.can_view_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_view:
        return error_response("Permission denied", status_code=403)

    stats = await ticket_service.get_attendance_stats(event_id)
    return success_response(stats)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/check-in-log', methods=['GET'])
@async_endpoint
@validate_query(CheckInLogParams)
async def get_check_in_log(community_id, event_id, query_params: CheckInLogParams):
    """Get check-in audit log for an event."""
    user_context = get_user_context()

    # Check permission
    can_view = await event_admin_service.can_view_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_view:
        return error_response("Permission denied", status_code=403)

    result = await ticket_service.get_check_in_log(
        event_id=event_id,
        limit=query_params.limit,
        offset=query_params.offset,
        success_only=query_params.success_only
    )
    return success_response(result)


@ticket_bp.route('/<int:community_id>/tickets/<int:ticket_id>/transfer', methods=['POST'])
@async_endpoint
@validate_json(TicketTransferRequest)
async def transfer_ticket(validated_data: TicketTransferRequest, community_id, ticket_id):
    """Transfer a ticket to a new holder (admin only)."""
    user_context = get_user_context()

    # Get ticket to check event_id
    ticket = await ticket_service.get_ticket(ticket_id)
    if not ticket:
        return error_response("Ticket not found", status_code=404)

    event_id = ticket['event_id']

    # Check permission
    can_transfer = await event_admin_service.can_transfer_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_transfer:
        return error_response("Permission denied", status_code=403)

    data = validated_data.dict()
    new_holder_context = {
        'user_id': data.get('new_holder_user_id'),
        'platform': data['new_holder_platform'],
        'platform_user_id': data['new_holder_platform_user_id'],
        'username': data['new_holder_username'],
        'holder_name': data['new_holder_name'],
        'holder_email': data.get('new_holder_email')
    }

    new_ticket = await ticket_service.transfer_ticket(
        ticket_id=ticket_id,
        new_holder_context=new_holder_context,
        operator_context=user_context,
        notes=data.get('notes')
    )

    if new_ticket:
        return success_response(new_ticket)
    else:
        return error_response("Failed to transfer ticket", status_code=400)


@ticket_bp.route('/<int:community_id>/tickets/<int:ticket_id>', methods=['DELETE'])
@async_endpoint
async def cancel_ticket(community_id, ticket_id):
    """Cancel a ticket."""
    user_context = get_user_context()

    # Get ticket to check event_id
    ticket = await ticket_service.get_ticket(ticket_id)
    if not ticket:
        return error_response("Ticket not found", status_code=404)

    event_id = ticket['event_id']

    # Check permission
    can_cancel = await event_admin_service.can_cancel_tickets(
        event_id, user_context
    ) if event_admin_service else True

    if not can_cancel:
        return error_response("Permission denied", status_code=403)

    # Get reason from query params
    reason = request.args.get('reason')

    success = await ticket_service.cancel_ticket(
        ticket_id=ticket_id,
        cancelled_by=user_context,
        reason=reason
    )

    if success:
        return success_response({'message': 'Ticket cancelled successfully'})
    else:
        return error_response("Failed to cancel ticket", status_code=400)


# ============================================================================
# EVENT ADMIN ENDPOINTS
# ============================================================================

@ticket_bp.route('/<int:community_id>/events/<int:event_id>/admins', methods=['GET'])
@async_endpoint
async def list_event_admins(community_id, event_id):
    """List event admins for an event."""
    user_context = get_user_context()

    # Check if user can view (event creator, community admin, or has assign permission)
    can_view = await event_admin_service.can_assign_event_admins(
        event_id, user_context
    ) if event_admin_service else True

    if not can_view:
        return error_response("Permission denied", status_code=403)

    admins = await event_admin_service.list_event_admins(event_id)
    return success_response({'admins': admins, 'count': len(admins)})


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/admins', methods=['POST'])
@async_endpoint
@validate_json(EventAdminAssignRequest)
async def assign_event_admin(validated_data: EventAdminAssignRequest, community_id, event_id):
    """Assign a user as an event admin."""
    user_context = get_user_context()

    result = await event_admin_service.assign_event_admin(
        event_id=event_id,
        assignee_data=validated_data.dict(),
        assigner_context=user_context
    )

    if result:
        return success_response(result, status_code=201)
    else:
        return error_response("Failed to assign event admin", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/admins/<int:admin_id>', methods=['PUT'])
@async_endpoint
@validate_json(EventAdminUpdateRequest)
async def update_event_admin(validated_data: EventAdminUpdateRequest, community_id, event_id, admin_id):
    """Update an event admin's permissions."""
    user_context = get_user_context()

    success = await event_admin_service.update_event_admin(
        event_admin_id=admin_id,
        updates=validated_data.dict(exclude_unset=True),
        operator_context=user_context
    )

    if success:
        return success_response({'message': 'Event admin updated successfully'})
    else:
        return error_response("Failed to update event admin", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/admins/<int:admin_id>', methods=['DELETE'])
@async_endpoint
async def revoke_event_admin(community_id, event_id, admin_id):
    """Revoke an event admin's access."""
    user_context = get_user_context()
    reason = request.args.get('reason')

    success = await event_admin_service.revoke_event_admin(
        event_admin_id=admin_id,
        operator_context=user_context,
        reason=reason
    )

    if success:
        return success_response({'message': 'Event admin revoked successfully'})
    else:
        return error_response("Failed to revoke event admin", status_code=400)


@ticket_bp.route('/<int:community_id>/events/<int:event_id>/my-permissions', methods=['GET'])
@async_endpoint
async def get_my_permissions(community_id, event_id):
    """Get current user's permissions for an event."""
    user_context = get_user_context()

    permissions = await event_admin_service.get_user_permissions(
        event_id, user_context
    ) if event_admin_service else {}

    return success_response({'permissions': permissions})


# Register blueprints
app.register_blueprint(calendar_bp)
app.register_blueprint(context_bp)
app.register_blueprint(ticket_bp)

if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
