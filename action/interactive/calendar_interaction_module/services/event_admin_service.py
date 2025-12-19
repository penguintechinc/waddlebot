"""
Event Admin Service - Per-event scoped admin role management
Allows event creators and community admins to delegate event management permissions
"""
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class EventAdminPermission(str, Enum):
    """Event admin permission types"""
    EDIT_EVENT = 'can_edit_event'
    CHECK_IN = 'can_check_in'
    VIEW_TICKETS = 'can_view_tickets'
    MANAGE_TICKET_TYPES = 'can_manage_ticket_types'
    CANCEL_TICKETS = 'can_cancel_tickets'
    TRANSFER_TICKETS = 'can_transfer_tickets'
    EXPORT_ATTENDANCE = 'can_export_attendance'
    ASSIGN_EVENT_ADMINS = 'can_assign_event_admins'


@dataclass
class EventAdminInfo:
    """Event admin information"""
    id: int
    event_id: int
    hub_user_id: Optional[int]
    platform: str
    platform_user_id: str
    username: str
    permissions: Dict[str, bool]
    is_active: bool
    assigned_by_username: Optional[str]
    assignment_notes: Optional[str]
    created_at: datetime


class EventAdminService:
    """
    Service for managing per-event admin roles.

    Features:
    - Granular permission assignments per event
    - Community admin/moderator override (always have full access)
    - Event creator always has full access
    - Delegation chain support (event admins with can_assign_event_admins can delegate)
    - AAA logging for all permission changes
    """

    def __init__(self, dal, permission_service=None):
        """Initialize event admin service."""
        self.dal = dal
        self.permission_service = permission_service

    async def assign_event_admin(
        self,
        event_id: int,
        assignee_data: Dict[str, Any],
        assigner_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Assign a user as an event admin with specified permissions.

        Args:
            event_id: Event ID
            assignee_data: User to assign and their permissions
            assigner_context: User performing the assignment

        Returns:
            Created event admin record or None on failure
        """
        try:
            # Check if assigner has permission to assign event admins
            can_assign = await self.can_assign_event_admins(
                event_id, assigner_context
            )
            if not can_assign:
                logger.warning(
                    f"[AUTHZ] DENIED: User {assigner_context.get('username')} "
                    f"cannot assign event admins for event {event_id}"
                )
                return None

            # Check if assignee is already an event admin
            existing = await self._get_event_admin(
                event_id,
                assignee_data.get('platform'),
                assignee_data.get('platform_user_id')
            )
            if existing:
                logger.info(
                    f"[AUDIT] EVENT_ADMIN_EXISTS: User {assignee_data.get('username')} "
                    f"is already an event admin for event {event_id}"
                )
                return existing

            # Insert event admin record
            query = """
                INSERT INTO calendar_event_admins (
                    event_id, hub_user_id, platform, platform_user_id, username,
                    can_edit_event, can_check_in, can_view_tickets,
                    can_manage_ticket_types, can_cancel_tickets, can_transfer_tickets,
                    can_export_attendance, can_assign_event_admins,
                    assigned_by, assigned_by_username, assignment_notes
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                RETURNING id, created_at
            """
            result = await self.dal.execute(query, [
                event_id,
                assignee_data.get('hub_user_id'),
                assignee_data.get('platform'),
                assignee_data.get('platform_user_id'),
                assignee_data.get('username'),
                assignee_data.get('can_edit_event', True),
                assignee_data.get('can_check_in', True),
                assignee_data.get('can_view_tickets', True),
                assignee_data.get('can_manage_ticket_types', False),
                assignee_data.get('can_cancel_tickets', False),
                assignee_data.get('can_transfer_tickets', False),
                assignee_data.get('can_export_attendance', True),
                assignee_data.get('can_assign_event_admins', False),
                assigner_context.get('user_id'),
                assigner_context.get('username'),
                assignee_data.get('assignment_notes')
            ])

            if result and len(result) > 0:
                logger.info(
                    f"[AUDIT] EVENT_ADMIN_ASSIGNED: event={event_id}, "
                    f"user={assignee_data.get('username')}, "
                    f"assigned_by={assigner_context.get('username')}"
                )

                return {
                    'id': result[0].get('id'),
                    'event_id': event_id,
                    'username': assignee_data.get('username'),
                    'platform': assignee_data.get('platform'),
                    'permissions': {
                        'can_edit_event': assignee_data.get('can_edit_event', True),
                        'can_check_in': assignee_data.get('can_check_in', True),
                        'can_view_tickets': assignee_data.get('can_view_tickets', True),
                        'can_manage_ticket_types': assignee_data.get('can_manage_ticket_types', False),
                        'can_cancel_tickets': assignee_data.get('can_cancel_tickets', False),
                        'can_transfer_tickets': assignee_data.get('can_transfer_tickets', False),
                        'can_export_attendance': assignee_data.get('can_export_attendance', True),
                        'can_assign_event_admins': assignee_data.get('can_assign_event_admins', False),
                    },
                    'created_at': result[0].get('created_at').isoformat()
                    if result[0].get('created_at') else None
                }

            return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to assign event admin: {str(e)}", exc_info=True)
            return None

    async def update_event_admin(
        self,
        event_admin_id: int,
        updates: Dict[str, Any],
        operator_context: Dict[str, Any]
    ) -> bool:
        """Update an event admin's permissions."""
        try:
            # Get event admin to check event_id
            admin_record = await self._get_event_admin_by_id(event_admin_id)
            if not admin_record:
                return False

            event_id = admin_record.get('event_id')

            # Check if operator can assign event admins
            can_assign = await self.can_assign_event_admins(event_id, operator_context)
            if not can_assign:
                logger.warning(
                    f"[AUTHZ] DENIED: User {operator_context.get('username')} "
                    f"cannot update event admin {event_admin_id}"
                )
                return False

            # Build update query dynamically
            update_fields = []
            params = []
            param_idx = 1

            permission_fields = [
                'can_edit_event', 'can_check_in', 'can_view_tickets',
                'can_manage_ticket_types', 'can_cancel_tickets', 'can_transfer_tickets',
                'can_export_attendance', 'can_assign_event_admins', 'assignment_notes'
            ]

            for field in permission_fields:
                if field in updates and updates[field] is not None:
                    update_fields.append(f"{field} = ${param_idx}")
                    params.append(updates[field])
                    param_idx += 1

            if not update_fields:
                return True  # Nothing to update

            update_fields.append("updated_at = NOW()")
            params.append(event_admin_id)

            query = f"""
                UPDATE calendar_event_admins
                SET {', '.join(update_fields)}
                WHERE id = ${param_idx}
            """
            await self.dal.execute(query, params)

            logger.info(
                f"[AUDIT] EVENT_ADMIN_UPDATED: id={event_admin_id}, "
                f"updated_by={operator_context.get('username')}, "
                f"fields={list(updates.keys())}"
            )

            return True

        except Exception as e:
            logger.error(f"[ERROR] Failed to update event admin: {str(e)}", exc_info=True)
            return False

    async def revoke_event_admin(
        self,
        event_admin_id: int,
        operator_context: Dict[str, Any],
        reason: Optional[str] = None
    ) -> bool:
        """Revoke an event admin's access."""
        try:
            # Get event admin to check event_id
            admin_record = await self._get_event_admin_by_id(event_admin_id)
            if not admin_record:
                return False

            event_id = admin_record.get('event_id')

            # Check if operator can assign event admins
            can_assign = await self.can_assign_event_admins(event_id, operator_context)
            if not can_assign:
                logger.warning(
                    f"[AUTHZ] DENIED: User {operator_context.get('username')} "
                    f"cannot revoke event admin {event_admin_id}"
                )
                return False

            now = datetime.now(timezone.utc)
            query = """
                UPDATE calendar_event_admins
                SET is_active = FALSE, revoked_at = $1, revoked_by = $2,
                    revoked_reason = $3, updated_at = NOW()
                WHERE id = $4
            """
            await self.dal.execute(query, [
                now,
                operator_context.get('user_id'),
                reason,
                event_admin_id
            ])

            logger.info(
                f"[AUDIT] EVENT_ADMIN_REVOKED: id={event_admin_id}, "
                f"revoked_by={operator_context.get('username')}, reason={reason}"
            )

            return True

        except Exception as e:
            logger.error(f"[ERROR] Failed to revoke event admin: {str(e)}", exc_info=True)
            return False

    async def list_event_admins(self, event_id: int) -> List[Dict[str, Any]]:
        """List all event admins for an event."""
        query = """
            SELECT *
            FROM calendar_event_admins
            WHERE event_id = $1 AND is_active = TRUE
            ORDER BY created_at ASC
        """
        result = await self.dal.execute(query, [event_id])

        admins = []
        for row in (result or []):
            admins.append({
                'id': row.get('id'),
                'event_id': row.get('event_id'),
                'hub_user_id': row.get('hub_user_id'),
                'platform': row.get('platform'),
                'platform_user_id': row.get('platform_user_id'),
                'username': row.get('username'),
                'permissions': {
                    'can_edit_event': row.get('can_edit_event'),
                    'can_check_in': row.get('can_check_in'),
                    'can_view_tickets': row.get('can_view_tickets'),
                    'can_manage_ticket_types': row.get('can_manage_ticket_types'),
                    'can_cancel_tickets': row.get('can_cancel_tickets'),
                    'can_transfer_tickets': row.get('can_transfer_tickets'),
                    'can_export_attendance': row.get('can_export_attendance'),
                    'can_assign_event_admins': row.get('can_assign_event_admins'),
                },
                'assigned_by_username': row.get('assigned_by_username'),
                'assignment_notes': row.get('assignment_notes'),
                'created_at': row.get('created_at').isoformat()
                if row.get('created_at') else None
            })

        return admins

    # =========================================================================
    # Permission Checking Methods
    # =========================================================================

    async def has_permission(
        self,
        event_id: int,
        user_context: Dict[str, Any],
        permission: EventAdminPermission
    ) -> bool:
        """
        Check if a user has a specific permission for an event.

        Permission hierarchy (in order of precedence):
        1. Community admin/moderator -> always has all permissions
        2. Event creator -> always has all permissions
        3. Event admin with specific permission granted
        """
        try:
            # Check community-level role first
            if await self._is_community_admin_or_mod(event_id, user_context):
                return True

            # Check if user is the event creator
            if await self._is_event_creator(event_id, user_context):
                return True

            # Check event admin permissions
            admin_record = await self._get_event_admin(
                event_id,
                user_context.get('platform'),
                user_context.get('platform_user_id')
            )

            if admin_record and admin_record.get('is_active'):
                return admin_record.get(permission.value, False)

            return False

        except Exception as e:
            logger.error(f"[ERROR] Permission check failed: {str(e)}", exc_info=True)
            return False

    async def can_check_in(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can perform check-ins for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.CHECK_IN
        )

    async def can_view_tickets(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can view tickets for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.VIEW_TICKETS
        )

    async def can_edit_event(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can edit an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.EDIT_EVENT
        )

    async def can_cancel_tickets(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can cancel tickets for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.CANCEL_TICKETS
        )

    async def can_transfer_tickets(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can transfer tickets for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.TRANSFER_TICKETS
        )

    async def can_export_attendance(self, event_id: int, user_context: Dict[str, Any]) -> bool:
        """Check if user can export attendance for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.EXPORT_ATTENDANCE
        )

    async def can_assign_event_admins(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> bool:
        """
        Check if user can assign event admins.
        Only community admins, event creators, or event admins with this permission can assign.
        """
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.ASSIGN_EVENT_ADMINS
        )

    async def can_manage_ticket_types(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> bool:
        """Check if user can manage ticket types for an event."""
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.MANAGE_TICKET_TYPES
        )

    async def can_configure_ticketing(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> bool:
        """Check if user can enable/disable ticketing for an event."""
        # Uses the same permission as managing ticket types
        return await self.has_permission(
            event_id, user_context, EventAdminPermission.MANAGE_TICKET_TYPES
        )

    async def get_user_permissions(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> Dict[str, bool]:
        """
        Get all permissions a user has for an event.
        Useful for frontend to show/hide UI elements.
        """
        # Community admin/mod or event creator has all permissions
        if await self._is_community_admin_or_mod(event_id, user_context):
            return {p.value: True for p in EventAdminPermission}

        if await self._is_event_creator(event_id, user_context):
            return {p.value: True for p in EventAdminPermission}

        # Get event admin record
        admin_record = await self._get_event_admin(
            event_id,
            user_context.get('platform'),
            user_context.get('platform_user_id')
        )

        if admin_record and admin_record.get('is_active'):
            return {
                p.value: admin_record.get(p.value, False)
                for p in EventAdminPermission
            }

        # No permissions
        return {p.value: False for p in EventAdminPermission}

    # =========================================================================
    # Private Helper Methods
    # =========================================================================

    async def _get_event_admin(
        self, event_id: int, platform: str, platform_user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get event admin record by user identification."""
        query = """
            SELECT *
            FROM calendar_event_admins
            WHERE event_id = $1 AND platform = $2 AND platform_user_id = $3
            AND is_active = TRUE
        """
        result = await self.dal.execute(query, [event_id, platform, platform_user_id])
        return result[0] if result and len(result) > 0 else None

    async def _get_event_admin_by_id(self, event_admin_id: int) -> Optional[Dict[str, Any]]:
        """Get event admin record by ID."""
        query = "SELECT * FROM calendar_event_admins WHERE id = $1"
        result = await self.dal.execute(query, [event_admin_id])
        return result[0] if result and len(result) > 0 else None

    async def _is_community_admin_or_mod(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> bool:
        """Check if user is a community admin or moderator for the event's community."""
        role = user_context.get('role', 'member')
        if role in ['admin', 'super_admin', 'community-admin', 'community-owner', 'moderator']:
            return True

        # If permission_service available, use it for more accurate check
        if self.permission_service:
            # Get event's community_id
            event_query = "SELECT community_id FROM calendar_events WHERE id = $1"
            event_result = await self.dal.execute(event_query, [event_id])
            if event_result and len(event_result) > 0:
                community_id = event_result[0].get('community_id')
                # Check if user can create events (implies admin/mod)
                return await self.permission_service.can_create_event(
                    user_context, community_id
                )

        return False

    async def _is_event_creator(
        self, event_id: int, user_context: Dict[str, Any]
    ) -> bool:
        """Check if user is the creator of the event."""
        query = """
            SELECT created_by_user_id, created_by_platform_user_id, platform
            FROM calendar_events
            WHERE id = $1
        """
        result = await self.dal.execute(query, [event_id])

        if result and len(result) > 0:
            event = result[0]

            # Check by hub user ID
            if (user_context.get('user_id') and
                    event.get('created_by_user_id') == user_context.get('user_id')):
                return True

            # Check by platform user ID
            if (event.get('platform') == user_context.get('platform') and
                    event.get('created_by_platform_user_id') == user_context.get('platform_user_id')):
                return True

        return False
