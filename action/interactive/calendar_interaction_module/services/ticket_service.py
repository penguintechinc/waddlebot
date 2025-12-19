"""
Ticket Service - Event ticketing with QR codes, check-in, and verification
Implements complete ticket lifecycle management for IRL and virtual events
"""
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


class TicketStatus(str, Enum):
    """Ticket status enumeration"""
    VALID = 'valid'
    CHECKED_IN = 'checked_in'
    CANCELLED = 'cancelled'
    EXPIRED = 'expired'
    REFUNDED = 'refunded'
    TRANSFERRED = 'transferred'


class CheckInMethod(str, Enum):
    """Check-in method enumeration"""
    QR_SCAN = 'qr_scan'
    MANUAL = 'manual'
    API = 'api'
    SELF_CHECKIN = 'self_checkin'
    AUTO_CHECKIN = 'auto_checkin'


class CheckInResult(str, Enum):
    """Check-in result codes"""
    SUCCESS = 'success'
    ALREADY_CHECKED_IN = 'already_checked_in'
    INVALID_TICKET = 'invalid_ticket'
    WRONG_EVENT = 'wrong_event'
    EXPIRED = 'expired'
    CANCELLED = 'cancelled'
    EVENT_NOT_STARTED = 'event_not_started'
    EVENT_ENDED = 'event_ended'
    UNAUTHORIZED = 'unauthorized'


@dataclass
class TicketInfo:
    """Ticket information data class"""
    id: int
    ticket_uuid: uuid.UUID
    ticket_code: str
    ticket_number: int
    event_id: int
    ticket_type_id: Optional[int]
    rsvp_id: Optional[int]
    hub_user_id: Optional[int]
    holder_name: Optional[str]
    holder_email: Optional[str]
    platform: str
    platform_user_id: str
    username: str
    status: str
    is_checked_in: bool
    checked_in_at: Optional[datetime]
    checked_in_by: Optional[int]
    check_in_method: Optional[str]
    is_paid: bool
    payment_status: Optional[str]
    guest_number: int
    created_at: datetime
    updated_at: datetime


@dataclass
class CheckInResponse:
    """Check-in operation response"""
    success: bool
    result_code: CheckInResult
    ticket: Optional[Dict[str, Any]] = None
    message: str = ""
    event_info: Optional[Dict[str, Any]] = None


class TicketService:
    """
    Ticket service for event ticketing and check-in management.

    Features:
    - Secure 64-char hex ticket code generation (256 bits entropy)
    - QR code verification endpoint
    - Check-in with multiple methods (QR, manual, API, self, auto)
    - Admin-only ticket transfers
    - Comprehensive AAA (Auth/Authz/Audit) logging
    """

    def __init__(self, dal, permission_service=None):
        """Initialize ticket service with database abstraction layer."""
        self.dal = dal
        self.permission_service = permission_service

    @staticmethod
    def generate_ticket_code() -> str:
        """
        Generate a secure 64-character hex ticket code.
        Uses 32 bytes of cryptographically secure random data (256 bits entropy).
        """
        return secrets.token_hex(32)

    async def create_ticket(
        self,
        event_id: int,
        user_context: Dict[str, Any],
        ticket_type_id: Optional[int] = None,
        rsvp_id: Optional[int] = None,
        holder_name: Optional[str] = None,
        holder_email: Optional[str] = None,
        is_paid: bool = False,
        payment_info: Optional[Dict[str, Any]] = None,
        guest_number: int = 1,
        primary_ticket_id: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Create a new ticket for an event.

        Args:
            event_id: Event ID
            user_context: User information (user_id, platform, platform_user_id, username)
            ticket_type_id: Optional ticket type ID
            rsvp_id: Optional RSVP ID to link
            holder_name: Optional holder name (defaults to username)
            holder_email: Optional email for ticket delivery
            is_paid: Whether this is a paid ticket
            payment_info: Payment details if paid
            guest_number: Guest number (1=primary, 2+=guests)
            primary_ticket_id: Primary ticket ID for guest tickets

        Returns:
            Created ticket dict or None on failure
        """
        try:
            # Check if event exists and has ticketing enabled
            event = await self._get_event(event_id)
            if not event:
                logger.error(f"[AUDIT] TICKET_CREATE_FAILED: Event {event_id} not found")
                return None

            if not event.get('ticketing_enabled'):
                logger.warning(
                    f"[AUDIT] TICKET_CREATE_FAILED: Ticketing not enabled for event {event_id}"
                )
                return None

            # Check ticket type capacity if specified
            if ticket_type_id:
                has_capacity = await self._check_ticket_type_capacity(ticket_type_id)
                if not has_capacity:
                    logger.warning(
                        f"[AUDIT] TICKET_CREATE_FAILED: Ticket type {ticket_type_id} at capacity"
                    )
                    return None

            # Check for existing ticket for this user/event
            existing = await self._get_user_ticket(
                event_id,
                user_context.get('platform'),
                user_context.get('platform_user_id')
            )
            if existing and guest_number == 1:
                logger.info(
                    f"[AUDIT] TICKET_EXISTS: User {user_context.get('username')} "
                    f"already has ticket for event {event_id}"
                )
                return existing

            # Generate unique ticket code
            ticket_code = self.generate_ticket_code()

            # Get next ticket number for this event
            ticket_number = await self._get_next_ticket_number(event_id)

            # Set holder name from context if not provided
            if not holder_name:
                holder_name = user_context.get('username')

            # Prepare payment fields
            payment_provider = None
            payment_id = None
            payment_amount_cents = 0
            payment_currency = 'USD'
            payment_status = None
            paid_at = None

            if is_paid and payment_info:
                payment_provider = payment_info.get('provider')
                payment_id = payment_info.get('payment_id')
                payment_amount_cents = payment_info.get('amount_cents', 0)
                payment_currency = payment_info.get('currency', 'USD')
                payment_status = payment_info.get('status', 'pending')
                if payment_status == 'completed':
                    paid_at = datetime.now(timezone.utc)

            # Insert ticket
            query = """
                INSERT INTO calendar_tickets (
                    ticket_code, ticket_number, event_id, ticket_type_id, rsvp_id,
                    hub_user_id, holder_name, holder_email, platform, platform_user_id, username,
                    status, is_paid, payment_provider, payment_id, payment_amount_cents,
                    payment_currency, payment_status, paid_at, guest_number, primary_ticket_id
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16, $17, $18, $19, $20, $21
                )
                RETURNING id, ticket_uuid, ticket_code, ticket_number, created_at
            """
            result = await self.dal.execute(query, [
                ticket_code,
                ticket_number,
                event_id,
                ticket_type_id,
                rsvp_id,
                user_context.get('user_id'),
                holder_name,
                holder_email,
                user_context.get('platform'),
                user_context.get('platform_user_id'),
                user_context.get('username'),
                TicketStatus.VALID.value,
                is_paid,
                payment_provider,
                payment_id,
                payment_amount_cents,
                payment_currency,
                payment_status,
                paid_at,
                guest_number,
                primary_ticket_id
            ])

            if result and len(result) > 0:
                ticket_data = result[0]

                # Update sold count if ticket type specified
                if ticket_type_id:
                    await self._increment_ticket_type_sold(ticket_type_id)

                logger.info(
                    f"[AUDIT] TICKET_CREATED: event={event_id}, "
                    f"ticket_number={ticket_number}, user={user_context.get('username')}, "
                    f"code={ticket_code[:8]}..."
                )

                return {
                    'id': ticket_data.get('id'),
                    'ticket_uuid': str(ticket_data.get('ticket_uuid')),
                    'ticket_code': ticket_code,
                    'ticket_number': ticket_number,
                    'event_id': event_id,
                    'holder_name': holder_name,
                    'status': TicketStatus.VALID.value,
                    'is_paid': is_paid,
                    'guest_number': guest_number,
                    'created_at': ticket_data.get('created_at').isoformat()
                    if ticket_data.get('created_at') else None
                }
            else:
                logger.error("[AUDIT] TICKET_CREATE_FAILED: Insert returned no data")
                return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to create ticket: {str(e)}", exc_info=True)
            return None

    async def verify_ticket(
        self,
        ticket_code: str,
        perform_checkin: bool = True,
        operator_context: Optional[Dict[str, Any]] = None,
        check_in_method: CheckInMethod = CheckInMethod.QR_SCAN,
        location: Optional[str] = None,
        device_info: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None
    ) -> CheckInResponse:
        """
        Verify a ticket code and optionally check-in the ticket.
        This is the main endpoint for QR code scanning.

        Args:
            ticket_code: 64-character hex ticket code
            perform_checkin: Whether to mark ticket as checked in
            operator_context: Admin/moderator performing check-in
            check_in_method: How the check-in was performed
            location: Optional location string
            device_info: Optional device information
            ip_address: Client IP address
            user_agent: Client user agent

        Returns:
            CheckInResponse with success status, result code, and ticket info
        """
        try:
            # Validate ticket code format
            if not ticket_code or len(ticket_code) != 64:
                await self._log_check_in_attempt(
                    ticket_id=None,
                    event_id=None,
                    ticket_code=ticket_code[:64] if ticket_code else None,
                    action='rejected',
                    success=False,
                    result_code=CheckInResult.INVALID_TICKET,
                    failure_reason='Invalid ticket code format',
                    operator_context=operator_context,
                    scan_method=check_in_method,
                    device_info=device_info,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    location=location
                )
                return CheckInResponse(
                    success=False,
                    result_code=CheckInResult.INVALID_TICKET,
                    message="Invalid ticket code format"
                )

            # Look up ticket
            query = """
                SELECT t.*, e.title as event_title, e.event_date, e.end_date,
                       e.check_in_mode, e.status as event_status, e.community_id,
                       tt.name as ticket_type_name
                FROM calendar_tickets t
                JOIN calendar_events e ON t.event_id = e.id
                LEFT JOIN calendar_ticket_types tt ON t.ticket_type_id = tt.id
                WHERE t.ticket_code = $1
            """
            result = await self.dal.execute(query, [ticket_code])

            if not result or len(result) == 0:
                await self._log_check_in_attempt(
                    ticket_id=None,
                    event_id=None,
                    ticket_code=ticket_code,
                    action='rejected',
                    success=False,
                    result_code=CheckInResult.INVALID_TICKET,
                    failure_reason='Ticket not found',
                    operator_context=operator_context,
                    scan_method=check_in_method,
                    device_info=device_info,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    location=location
                )
                return CheckInResponse(
                    success=False,
                    result_code=CheckInResult.INVALID_TICKET,
                    message="Ticket not found"
                )

            ticket = result[0]
            ticket_id = ticket.get('id')
            event_id = ticket.get('event_id')

            # Check ticket status
            ticket_status = ticket.get('status')
            if ticket_status == TicketStatus.CANCELLED.value:
                await self._log_check_in_attempt(
                    ticket_id=ticket_id,
                    event_id=event_id,
                    ticket_code=ticket_code,
                    action='rejected',
                    success=False,
                    result_code=CheckInResult.CANCELLED,
                    failure_reason='Ticket has been cancelled',
                    operator_context=operator_context,
                    scan_method=check_in_method,
                    holder_username=ticket.get('username'),
                    holder_hub_user_id=ticket.get('hub_user_id'),
                    ticket_type_name=ticket.get('ticket_type_name'),
                    device_info=device_info,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    location=location
                )
                return CheckInResponse(
                    success=False,
                    result_code=CheckInResult.CANCELLED,
                    message="This ticket has been cancelled"
                )

            if ticket_status == TicketStatus.EXPIRED.value:
                await self._log_check_in_attempt(
                    ticket_id=ticket_id,
                    event_id=event_id,
                    ticket_code=ticket_code,
                    action='rejected',
                    success=False,
                    result_code=CheckInResult.EXPIRED,
                    failure_reason='Ticket has expired',
                    operator_context=operator_context,
                    scan_method=check_in_method,
                    holder_username=ticket.get('username'),
                    holder_hub_user_id=ticket.get('hub_user_id'),
                    ticket_type_name=ticket.get('ticket_type_name'),
                    device_info=device_info,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    location=location
                )
                return CheckInResponse(
                    success=False,
                    result_code=CheckInResult.EXPIRED,
                    message="This ticket has expired"
                )

            # Check if already checked in
            if ticket.get('is_checked_in'):
                checked_in_at = ticket.get('checked_in_at')
                await self._log_check_in_attempt(
                    ticket_id=ticket_id,
                    event_id=event_id,
                    ticket_code=ticket_code,
                    action='rejected',
                    success=False,
                    result_code=CheckInResult.ALREADY_CHECKED_IN,
                    failure_reason='Already checked in',
                    operator_context=operator_context,
                    scan_method=check_in_method,
                    holder_username=ticket.get('username'),
                    holder_hub_user_id=ticket.get('hub_user_id'),
                    ticket_type_name=ticket.get('ticket_type_name'),
                    device_info=device_info,
                    ip_address=ip_address,
                    user_agent=user_agent,
                    location=location
                )
                return CheckInResponse(
                    success=False,
                    result_code=CheckInResult.ALREADY_CHECKED_IN,
                    message=f"Ticket already checked in at {checked_in_at}",
                    ticket=self._format_ticket_response(ticket)
                )

            # Build ticket info for response
            ticket_info = self._format_ticket_response(ticket)
            event_info = {
                'id': event_id,
                'title': ticket.get('event_title'),
                'event_date': ticket.get('event_date').isoformat()
                if ticket.get('event_date') else None,
                'community_id': ticket.get('community_id')
            }

            # If not performing check-in, just return valid ticket info
            if not perform_checkin:
                return CheckInResponse(
                    success=True,
                    result_code=CheckInResult.SUCCESS,
                    message="Ticket is valid",
                    ticket=ticket_info,
                    event_info=event_info
                )

            # Perform check-in
            operator_id = operator_context.get('user_id') if operator_context else None
            now = datetime.now(timezone.utc)

            update_query = """
                UPDATE calendar_tickets
                SET is_checked_in = TRUE,
                    checked_in_at = $1,
                    checked_in_by = $2,
                    check_in_method = $3,
                    check_in_location = $4,
                    status = $5,
                    updated_at = NOW()
                WHERE id = $6
                RETURNING id
            """
            await self.dal.execute(update_query, [
                now,
                operator_id,
                check_in_method.value,
                location,
                TicketStatus.CHECKED_IN.value,
                ticket_id
            ])

            # Log successful check-in
            await self._log_check_in_attempt(
                ticket_id=ticket_id,
                event_id=event_id,
                ticket_code=ticket_code,
                action='check_in',
                success=True,
                result_code=CheckInResult.SUCCESS,
                failure_reason=None,
                operator_context=operator_context,
                scan_method=check_in_method,
                holder_username=ticket.get('username'),
                holder_hub_user_id=ticket.get('hub_user_id'),
                ticket_type_name=ticket.get('ticket_type_name'),
                device_info=device_info,
                ip_address=ip_address,
                user_agent=user_agent,
                location=location
            )

            logger.info(
                f"[AUDIT] CHECK_IN_SUCCESS: ticket={ticket_id}, event={event_id}, "
                f"holder={ticket.get('username')}, method={check_in_method.value}"
            )

            # Update ticket info with check-in data
            ticket_info['is_checked_in'] = True
            ticket_info['checked_in_at'] = now.isoformat()
            ticket_info['status'] = TicketStatus.CHECKED_IN.value

            return CheckInResponse(
                success=True,
                result_code=CheckInResult.SUCCESS,
                message="Check-in successful",
                ticket=ticket_info,
                event_info=event_info
            )

        except Exception as e:
            logger.error(f"[ERROR] Ticket verification failed: {str(e)}", exc_info=True)
            return CheckInResponse(
                success=False,
                result_code=CheckInResult.INVALID_TICKET,
                message="An error occurred during verification"
            )

    async def undo_check_in(
        self,
        ticket_id: int,
        operator_context: Dict[str, Any],
        reason: Optional[str] = None
    ) -> bool:
        """
        Undo a check-in (for corrections).

        Args:
            ticket_id: Ticket ID
            operator_context: Admin/moderator undoing the check-in
            reason: Optional reason for undoing

        Returns:
            True if successful, False otherwise
        """
        try:
            # Get ticket info
            query = """
                SELECT t.*, e.id as event_id
                FROM calendar_tickets t
                JOIN calendar_events e ON t.event_id = e.id
                WHERE t.id = $1
            """
            result = await self.dal.execute(query, [ticket_id])

            if not result or len(result) == 0:
                logger.warning(f"[AUDIT] UNDO_CHECK_IN_FAILED: Ticket {ticket_id} not found")
                return False

            ticket = result[0]

            if not ticket.get('is_checked_in'):
                logger.warning(f"[AUDIT] UNDO_CHECK_IN_FAILED: Ticket {ticket_id} not checked in")
                return False

            # Update ticket
            update_query = """
                UPDATE calendar_tickets
                SET is_checked_in = FALSE,
                    checked_in_at = NULL,
                    checked_in_by = NULL,
                    check_in_method = NULL,
                    check_in_location = NULL,
                    check_in_notes = $1,
                    status = $2,
                    updated_at = NOW()
                WHERE id = $3
            """
            await self.dal.execute(update_query, [
                f"Check-in undone: {reason}" if reason else "Check-in undone",
                TicketStatus.VALID.value,
                ticket_id
            ])

            # Log the undo action
            await self._log_check_in_attempt(
                ticket_id=ticket_id,
                event_id=ticket.get('event_id'),
                ticket_code=ticket.get('ticket_code'),
                action='undo_check_in',
                success=True,
                result_code=CheckInResult.SUCCESS,
                failure_reason=reason,
                operator_context=operator_context,
                scan_method=CheckInMethod.MANUAL,
                holder_username=ticket.get('username'),
                holder_hub_user_id=ticket.get('hub_user_id'),
                ticket_type_name=None
            )

            logger.info(
                f"[AUDIT] CHECK_IN_UNDONE: ticket={ticket_id}, "
                f"operator={operator_context.get('username')}, reason={reason}"
            )

            return True

        except Exception as e:
            logger.error(f"[ERROR] Failed to undo check-in: {str(e)}", exc_info=True)
            return False

    async def transfer_ticket(
        self,
        ticket_id: int,
        new_holder_context: Dict[str, Any],
        operator_context: Dict[str, Any],
        notes: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Transfer a ticket to a new holder (admin-only operation).

        Args:
            ticket_id: Ticket ID to transfer
            new_holder_context: New holder information
            operator_context: Admin performing the transfer
            notes: Optional transfer notes

        Returns:
            Updated ticket dict or None on failure
        """
        try:
            # Get current ticket
            query = "SELECT * FROM calendar_tickets WHERE id = $1"
            result = await self.dal.execute(query, [ticket_id])

            if not result or len(result) == 0:
                logger.warning(f"[AUDIT] TRANSFER_FAILED: Ticket {ticket_id} not found")
                return None

            ticket = result[0]

            # Can't transfer checked-in tickets
            if ticket.get('is_checked_in'):
                logger.warning(
                    f"[AUDIT] TRANSFER_FAILED: Cannot transfer checked-in ticket {ticket_id}"
                )
                return None

            # Can't transfer cancelled/expired tickets
            if ticket.get('status') in [TicketStatus.CANCELLED.value, TicketStatus.EXPIRED.value]:
                logger.warning(
                    f"[AUDIT] TRANSFER_FAILED: Cannot transfer {ticket.get('status')} ticket"
                )
                return None

            # Create new ticket for new holder
            new_ticket_code = self.generate_ticket_code()
            new_ticket_number = await self._get_next_ticket_number(ticket.get('event_id'))

            now = datetime.now(timezone.utc)

            insert_query = """
                INSERT INTO calendar_tickets (
                    ticket_code, ticket_number, event_id, ticket_type_id, rsvp_id,
                    hub_user_id, holder_name, holder_email, platform, platform_user_id, username,
                    status, is_paid, payment_provider, payment_id, payment_amount_cents,
                    payment_currency, payment_status, paid_at, guest_number,
                    transferred_from_ticket_id, transferred_at, transferred_by, transfer_notes
                )
                VALUES (
                    $1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    $15, $16, $17, $18, $19, $20, $21, $22, $23
                )
                RETURNING id, ticket_uuid, ticket_code, ticket_number
            """
            new_result = await self.dal.execute(insert_query, [
                new_ticket_code,
                new_ticket_number,
                ticket.get('event_id'),
                ticket.get('ticket_type_id'),
                new_holder_context.get('user_id'),
                new_holder_context.get('holder_name', new_holder_context.get('username')),
                new_holder_context.get('holder_email'),
                new_holder_context.get('platform'),
                new_holder_context.get('platform_user_id'),
                new_holder_context.get('username'),
                TicketStatus.VALID.value,
                ticket.get('is_paid'),
                ticket.get('payment_provider'),
                ticket.get('payment_id'),
                ticket.get('payment_amount_cents'),
                ticket.get('payment_currency'),
                ticket.get('payment_status'),
                ticket.get('paid_at'),
                ticket.get('guest_number'),
                ticket_id,
                now,
                operator_context.get('user_id'),
                notes
            ])

            # Mark old ticket as transferred
            update_query = """
                UPDATE calendar_tickets
                SET status = $1, updated_at = NOW()
                WHERE id = $2
            """
            await self.dal.execute(update_query, [TicketStatus.TRANSFERRED.value, ticket_id])

            if new_result and len(new_result) > 0:
                new_ticket = new_result[0]

                logger.info(
                    f"[AUDIT] TICKET_TRANSFERRED: old_ticket={ticket_id}, "
                    f"new_ticket={new_ticket.get('id')}, "
                    f"from={ticket.get('username')}, "
                    f"to={new_holder_context.get('username')}, "
                    f"operator={operator_context.get('username')}"
                )

                return {
                    'id': new_ticket.get('id'),
                    'ticket_uuid': str(new_ticket.get('ticket_uuid')),
                    'ticket_code': new_ticket_code,
                    'ticket_number': new_ticket_number,
                    'transferred_from': ticket_id,
                    'status': TicketStatus.VALID.value
                }

            return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to transfer ticket: {str(e)}", exc_info=True)
            return None

    async def cancel_ticket(
        self,
        ticket_id: int,
        cancelled_by: Dict[str, Any],
        reason: Optional[str] = None
    ) -> bool:
        """Cancel a ticket."""
        try:
            now = datetime.now(timezone.utc)
            query = """
                UPDATE calendar_tickets
                SET status = $1, cancelled_at = $2, cancelled_by = $3,
                    cancelled_reason = $4, updated_at = NOW()
                WHERE id = $5 AND status NOT IN ($6, $7)
                RETURNING id, ticket_type_id
            """
            result = await self.dal.execute(query, [
                TicketStatus.CANCELLED.value,
                now,
                cancelled_by.get('user_id'),
                reason,
                ticket_id,
                TicketStatus.CANCELLED.value,
                TicketStatus.CHECKED_IN.value
            ])

            if result and len(result) > 0:
                # Decrement sold count
                ticket_type_id = result[0].get('ticket_type_id')
                if ticket_type_id:
                    await self._decrement_ticket_type_sold(ticket_type_id)

                logger.info(
                    f"[AUDIT] TICKET_CANCELLED: ticket={ticket_id}, "
                    f"by={cancelled_by.get('username')}, reason={reason}"
                )
                return True

            return False

        except Exception as e:
            logger.error(f"[ERROR] Failed to cancel ticket: {str(e)}", exc_info=True)
            return False

    async def get_ticket(self, ticket_id: int) -> Optional[Dict[str, Any]]:
        """Get ticket by ID."""
        query = """
            SELECT t.*, e.title as event_title, e.event_date,
                   tt.name as ticket_type_name
            FROM calendar_tickets t
            JOIN calendar_events e ON t.event_id = e.id
            LEFT JOIN calendar_ticket_types tt ON t.ticket_type_id = tt.id
            WHERE t.id = $1
        """
        result = await self.dal.execute(query, [ticket_id])
        if result and len(result) > 0:
            return self._format_ticket_response(result[0])
        return None

    async def get_ticket_by_code(self, ticket_code: str) -> Optional[Dict[str, Any]]:
        """Get ticket by ticket code."""
        query = """
            SELECT t.*, e.title as event_title, e.event_date,
                   tt.name as ticket_type_name
            FROM calendar_tickets t
            JOIN calendar_events e ON t.event_id = e.id
            LEFT JOIN calendar_ticket_types tt ON t.ticket_type_id = tt.id
            WHERE t.ticket_code = $1
        """
        result = await self.dal.execute(query, [ticket_code])
        if result and len(result) > 0:
            return self._format_ticket_response(result[0])
        return None

    async def list_tickets(
        self,
        event_id: int,
        status: Optional[str] = None,
        is_checked_in: Optional[bool] = None,
        ticket_type_id: Optional[int] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0
    ) -> Dict[str, Any]:
        """List tickets for an event with filters."""
        conditions = ["t.event_id = $1"]
        params = [event_id]
        param_idx = 2

        if status:
            conditions.append(f"t.status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if is_checked_in is not None:
            conditions.append(f"t.is_checked_in = ${param_idx}")
            params.append(is_checked_in)
            param_idx += 1

        if ticket_type_id:
            conditions.append(f"t.ticket_type_id = ${param_idx}")
            params.append(ticket_type_id)
            param_idx += 1

        if search:
            conditions.append(
                f"(t.username ILIKE ${param_idx} OR t.holder_name ILIKE ${param_idx} "
                f"OR t.holder_email ILIKE ${param_idx})"
            )
            params.append(f"%{search}%")
            param_idx += 1

        where_clause = " AND ".join(conditions)

        # Get count
        count_query = f"""
            SELECT COUNT(*) as count
            FROM calendar_tickets t
            WHERE {where_clause}
        """
        count_result = await self.dal.execute(count_query, params)
        total = count_result[0].get('count', 0) if count_result else 0

        # Get tickets
        query = f"""
            SELECT t.*, tt.name as ticket_type_name
            FROM calendar_tickets t
            LEFT JOIN calendar_ticket_types tt ON t.ticket_type_id = tt.id
            WHERE {where_clause}
            ORDER BY t.ticket_number ASC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])

        result = await self.dal.execute(query, params)
        tickets = [self._format_ticket_response(t) for t in (result or [])]

        return {
            'tickets': tickets,
            'count': len(tickets),
            'total': total,
            'limit': limit,
            'offset': offset
        }

    async def get_attendance_stats(self, event_id: int) -> Dict[str, Any]:
        """Get attendance statistics for an event."""
        query = """
            SELECT
                COUNT(*) as total_tickets,
                COUNT(*) FILTER (WHERE is_checked_in = TRUE) as checked_in,
                COUNT(*) FILTER (WHERE is_checked_in = FALSE AND status = 'valid') as not_checked_in,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
                COUNT(*) FILTER (WHERE status = 'refunded') as refunded
            FROM calendar_tickets
            WHERE event_id = $1
        """
        result = await self.dal.execute(query, [event_id])

        if result and len(result) > 0:
            stats = result[0]
            total = stats.get('total_tickets', 0)
            checked_in = stats.get('checked_in', 0)

            return {
                'total_tickets': total,
                'checked_in': checked_in,
                'not_checked_in': stats.get('not_checked_in', 0),
                'cancelled': stats.get('cancelled', 0),
                'refunded': stats.get('refunded', 0),
                'check_in_rate': round((checked_in / total * 100), 1) if total > 0 else 0
            }

        return {
            'total_tickets': 0,
            'checked_in': 0,
            'not_checked_in': 0,
            'cancelled': 0,
            'refunded': 0,
            'check_in_rate': 0
        }

    async def get_check_in_log(
        self,
        event_id: int,
        limit: int = 50,
        offset: int = 0,
        success_only: bool = False
    ) -> Dict[str, Any]:
        """Get check-in audit log for an event."""
        conditions = ["event_id = $1"]
        params = [event_id]
        param_idx = 2

        if success_only:
            conditions.append("success = TRUE")

        where_clause = " AND ".join(conditions)

        # Get count
        count_query = f"""
            SELECT COUNT(*) as count
            FROM calendar_ticket_check_ins
            WHERE {where_clause}
        """
        count_result = await self.dal.execute(count_query, params)
        total = count_result[0].get('count', 0) if count_result else 0

        # Get logs
        query = f"""
            SELECT *
            FROM calendar_ticket_check_ins
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """
        params.extend([limit, offset])

        result = await self.dal.execute(query, params)
        logs = []
        for log in (result or []):
            logs.append({
                'id': log.get('id'),
                'ticket_id': log.get('ticket_id'),
                'ticket_code': log.get('ticket_code')[:8] + '...' if log.get('ticket_code') else None,
                'action': log.get('action'),
                'success': log.get('success'),
                'result_code': log.get('result_code'),
                'failure_reason': log.get('failure_reason'),
                'operator_username': log.get('operator_username'),
                'holder_username': log.get('holder_username'),
                'ticket_type_name': log.get('ticket_type_name'),
                'scan_method': log.get('scan_method'),
                'location': log.get('location'),
                'created_at': log.get('created_at').isoformat()
                if log.get('created_at') else None
            })

        return {
            'logs': logs,
            'count': len(logs),
            'total': total,
            'limit': limit,
            'offset': offset
        }

    # =========================================================================
    # Ticket Type Management
    # =========================================================================

    async def create_ticket_type(
        self,
        event_id: int,
        name: str,
        description: Optional[str] = None,
        max_quantity: Optional[int] = None,
        price_cents: int = 0,
        currency: str = 'USD',
        sales_start: Optional[datetime] = None,
        sales_end: Optional[datetime] = None,
        display_order: int = 0
    ) -> Optional[Dict[str, Any]]:
        """Create a new ticket type for an event."""
        try:
            is_paid = price_cents > 0

            query = """
                INSERT INTO calendar_ticket_types (
                    event_id, name, description, max_quantity, is_paid,
                    price_cents, currency, sales_start, sales_end, display_order
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id, name, created_at
            """
            result = await self.dal.execute(query, [
                event_id, name, description, max_quantity, is_paid,
                price_cents, currency, sales_start, sales_end, display_order
            ])

            if result and len(result) > 0:
                logger.info(f"[AUDIT] TICKET_TYPE_CREATED: event={event_id}, name={name}")
                return {
                    'id': result[0].get('id'),
                    'name': name,
                    'event_id': event_id,
                    'is_paid': is_paid,
                    'price_cents': price_cents,
                    'currency': currency
                }

            return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to create ticket type: {str(e)}", exc_info=True)
            return None

    async def list_ticket_types(self, event_id: int) -> List[Dict[str, Any]]:
        """List ticket types for an event."""
        query = """
            SELECT *
            FROM calendar_ticket_types
            WHERE event_id = $1 AND is_active = TRUE
            ORDER BY display_order ASC, id ASC
        """
        result = await self.dal.execute(query, [event_id])

        types = []
        for tt in (result or []):
            available = None
            if tt.get('max_quantity'):
                available = tt.get('max_quantity') - tt.get('sold_count', 0)

            types.append({
                'id': tt.get('id'),
                'name': tt.get('name'),
                'description': tt.get('description'),
                'max_quantity': tt.get('max_quantity'),
                'sold_count': tt.get('sold_count'),
                'available': available,
                'is_paid': tt.get('is_paid'),
                'price_cents': tt.get('price_cents'),
                'currency': tt.get('currency'),
                'sales_start': tt.get('sales_start').isoformat()
                if tt.get('sales_start') else None,
                'sales_end': tt.get('sales_end').isoformat()
                if tt.get('sales_end') else None,
                'is_visible': tt.get('is_visible')
            })

        return types

    async def update_ticket_type(
        self,
        ticket_type_id: int,
        user_context: Dict[str, Any],
        **kwargs
    ) -> Optional[Dict[str, Any]]:
        """
        Update a ticket type.

        Args:
            ticket_type_id: Ticket type ID
            user_context: User context for audit logging
            **kwargs: Fields to update (name, description, max_quantity, etc.)

        Returns:
            Updated ticket type dict or None on failure
        """
        try:
            # Build update query dynamically
            update_fields = []
            params = []
            param_idx = 1

            field_map = {
                'name': 'name',
                'description': 'description',
                'max_quantity': 'max_quantity',
                'price_cents': 'price_cents',
                'currency': 'currency',
                'sales_start': 'sales_start',
                'sales_end': 'sales_end',
                'is_visible': 'is_visible',
                'display_order': 'display_order'
            }

            for key, col in field_map.items():
                if key in kwargs and kwargs[key] is not None:
                    update_fields.append(f"{col} = ${param_idx}")
                    params.append(kwargs[key])
                    param_idx += 1

            if not update_fields:
                return None

            params.append(ticket_type_id)
            query = f"""
                UPDATE calendar_ticket_types
                SET {', '.join(update_fields)}, updated_at = NOW()
                WHERE id = ${param_idx}
                RETURNING *
            """

            result = await self.dal.execute(query, params)
            if result and len(result) > 0:
                tt = result[0]
                logger.info(
                    f"[AUDIT] TICKET_TYPE_UPDATED: type_id={ticket_type_id} "
                    f"by user={user_context.get('username')}"
                )
                return {
                    'id': tt.get('id'),
                    'name': tt.get('name'),
                    'description': tt.get('description'),
                    'max_quantity': tt.get('max_quantity'),
                    'price_cents': tt.get('price_cents'),
                    'currency': tt.get('currency'),
                    'is_visible': tt.get('is_visible')
                }
            return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to update ticket type: {str(e)}", exc_info=True)
            return None

    async def delete_ticket_type(
        self,
        ticket_type_id: int,
        user_context: Dict[str, Any]
    ) -> bool:
        """
        Delete a ticket type (only if no tickets have been issued).

        Args:
            ticket_type_id: Ticket type ID
            user_context: User context for audit logging

        Returns:
            True if deleted, False otherwise
        """
        try:
            # Check if any tickets exist for this type
            check_query = """
                SELECT COUNT(*) as count FROM calendar_tickets
                WHERE ticket_type_id = $1
            """
            result = await self.dal.execute(check_query, [ticket_type_id])
            if result and result[0].get('count', 0) > 0:
                logger.warning(
                    f"[AUDIT] TICKET_TYPE_DELETE_BLOCKED: type_id={ticket_type_id} "
                    f"has existing tickets"
                )
                return False

            # Delete the ticket type
            delete_query = "DELETE FROM calendar_ticket_types WHERE id = $1 RETURNING id"
            result = await self.dal.execute(delete_query, [ticket_type_id])

            if result and len(result) > 0:
                logger.info(
                    f"[AUDIT] TICKET_TYPE_DELETED: type_id={ticket_type_id} "
                    f"by user={user_context.get('username')}"
                )
                return True
            return False

        except Exception as e:
            logger.error(f"[ERROR] Failed to delete ticket type: {str(e)}", exc_info=True)
            return False

    async def enable_ticketing(
        self,
        event_id: int,
        user_context: Dict[str, Any],
        **kwargs
    ) -> Optional[Dict[str, Any]]:
        """
        Enable ticketing for an event.

        Args:
            event_id: Event ID
            user_context: User context for audit logging
            **kwargs: Configuration options (check_in_mode, self_checkin_enabled, etc.)

        Returns:
            Ticketing config dict or None on failure
        """
        try:
            # Check if config already exists
            check_query = "SELECT * FROM calendar_ticketing_config WHERE event_id = $1"
            existing = await self.dal.execute(check_query, [event_id])

            check_in_mode = kwargs.get('check_in_mode', 'admin_only')
            self_checkin_enabled = kwargs.get('self_checkin_enabled', False)
            auto_checkin_rsvp = kwargs.get('auto_checkin_rsvp', False)
            refund_policy_event = kwargs.get('refund_policy_event')
            refund_policy_type = kwargs.get('refund_policy_type')

            if existing and len(existing) > 0:
                # Update existing config
                update_query = """
                    UPDATE calendar_ticketing_config
                    SET ticketing_enabled = TRUE,
                        check_in_mode = $2,
                        self_checkin_enabled = $3,
                        auto_checkin_rsvp = $4,
                        refund_policy_event = $5,
                        refund_policy_type = $6,
                        updated_at = NOW()
                    WHERE event_id = $1
                    RETURNING *
                """
                result = await self.dal.execute(update_query, [
                    event_id, check_in_mode, self_checkin_enabled,
                    auto_checkin_rsvp, refund_policy_event, refund_policy_type
                ])
            else:
                # Create new config
                insert_query = """
                    INSERT INTO calendar_ticketing_config (
                        event_id, ticketing_enabled, check_in_mode,
                        self_checkin_enabled, auto_checkin_rsvp,
                        refund_policy_event, refund_policy_type
                    ) VALUES ($1, TRUE, $2, $3, $4, $5, $6)
                    RETURNING *
                """
                result = await self.dal.execute(insert_query, [
                    event_id, check_in_mode, self_checkin_enabled,
                    auto_checkin_rsvp, refund_policy_event, refund_policy_type
                ])

            if result and len(result) > 0:
                config = result[0]
                logger.info(
                    f"[AUDIT] TICKETING_ENABLED: event_id={event_id} "
                    f"mode={check_in_mode} by user={user_context.get('username')}"
                )
                return {
                    'event_id': config.get('event_id'),
                    'ticketing_enabled': config.get('ticketing_enabled'),
                    'check_in_mode': config.get('check_in_mode'),
                    'self_checkin_enabled': config.get('self_checkin_enabled'),
                    'auto_checkin_rsvp': config.get('auto_checkin_rsvp'),
                    'refund_policy_event': config.get('refund_policy_event'),
                    'refund_policy_type': config.get('refund_policy_type')
                }
            return None

        except Exception as e:
            logger.error(f"[ERROR] Failed to enable ticketing: {str(e)}", exc_info=True)
            return None

    async def disable_ticketing(
        self,
        event_id: int,
        user_context: Dict[str, Any]
    ) -> bool:
        """
        Disable ticketing for an event.

        Args:
            event_id: Event ID
            user_context: User context for audit logging

        Returns:
            True if disabled, False otherwise
        """
        try:
            query = """
                UPDATE calendar_ticketing_config
                SET ticketing_enabled = FALSE, updated_at = NOW()
                WHERE event_id = $1
                RETURNING id
            """
            result = await self.dal.execute(query, [event_id])

            if result and len(result) > 0:
                logger.info(
                    f"[AUDIT] TICKETING_DISABLED: event_id={event_id} "
                    f"by user={user_context.get('username')}"
                )
                return True

            # If no config existed, that's okay - ticketing was never enabled
            return True

        except Exception as e:
            logger.error(f"[ERROR] Failed to disable ticketing: {str(e)}", exc_info=True)
            return False

    # =========================================================================
    # Private Helper Methods
    # =========================================================================

    async def _get_event(self, event_id: int) -> Optional[Dict[str, Any]]:
        """Get event by ID."""
        query = "SELECT * FROM calendar_events WHERE id = $1"
        result = await self.dal.execute(query, [event_id])
        return result[0] if result and len(result) > 0 else None

    async def _get_user_ticket(
        self,
        event_id: int,
        platform: str,
        platform_user_id: str
    ) -> Optional[Dict[str, Any]]:
        """Get existing ticket for user/event combination."""
        query = """
            SELECT * FROM calendar_tickets
            WHERE event_id = $1 AND platform = $2 AND platform_user_id = $3
            AND guest_number = 1 AND status NOT IN ('cancelled', 'transferred')
        """
        result = await self.dal.execute(query, [event_id, platform, platform_user_id])
        if result and len(result) > 0:
            return self._format_ticket_response(result[0])
        return None

    async def _get_next_ticket_number(self, event_id: int) -> int:
        """Get next sequential ticket number for event."""
        query = """
            SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_num
            FROM calendar_tickets
            WHERE event_id = $1
        """
        result = await self.dal.execute(query, [event_id])
        return result[0].get('next_num', 1) if result else 1

    async def _check_ticket_type_capacity(self, ticket_type_id: int) -> bool:
        """Check if ticket type has available capacity."""
        query = """
            SELECT max_quantity, sold_count
            FROM calendar_ticket_types
            WHERE id = $1
        """
        result = await self.dal.execute(query, [ticket_type_id])
        if result and len(result) > 0:
            tt = result[0]
            max_qty = tt.get('max_quantity')
            if max_qty is None:
                return True  # Unlimited
            sold = tt.get('sold_count', 0)
            return sold < max_qty
        return False

    async def _increment_ticket_type_sold(self, ticket_type_id: int) -> None:
        """Increment sold count for ticket type."""
        query = """
            UPDATE calendar_ticket_types
            SET sold_count = sold_count + 1, updated_at = NOW()
            WHERE id = $1
        """
        await self.dal.execute(query, [ticket_type_id])

    async def _decrement_ticket_type_sold(self, ticket_type_id: int) -> None:
        """Decrement sold count for ticket type."""
        query = """
            UPDATE calendar_ticket_types
            SET sold_count = GREATEST(sold_count - 1, 0), updated_at = NOW()
            WHERE id = $1
        """
        await self.dal.execute(query, [ticket_type_id])

    async def _log_check_in_attempt(
        self,
        ticket_id: Optional[int],
        event_id: Optional[int],
        ticket_code: Optional[str],
        action: str,
        success: bool,
        result_code: CheckInResult,
        failure_reason: Optional[str],
        operator_context: Optional[Dict[str, Any]],
        scan_method: CheckInMethod,
        holder_username: Optional[str] = None,
        holder_hub_user_id: Optional[int] = None,
        ticket_type_name: Optional[str] = None,
        device_info: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        location: Optional[str] = None
    ) -> None:
        """Log a check-in attempt to the audit table."""
        try:
            import json

            operator_user_id = operator_context.get('user_id') if operator_context else None
            operator_username = operator_context.get('username') if operator_context else None
            operator_role = operator_context.get('role') if operator_context else None

            query = """
                INSERT INTO calendar_ticket_check_ins (
                    ticket_id, event_id, action, ticket_code, success, result_code,
                    failure_reason, operator_user_id, operator_username, operator_role,
                    holder_username, holder_hub_user_id, ticket_type_name,
                    scan_method, device_info, ip_address, user_agent, location
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            """
            await self.dal.execute(query, [
                ticket_id,
                event_id,
                action,
                ticket_code,
                success,
                result_code.value,
                failure_reason,
                operator_user_id,
                operator_username,
                operator_role,
                holder_username,
                holder_hub_user_id,
                ticket_type_name,
                scan_method.value,
                json.dumps(device_info) if device_info else None,
                ip_address,
                user_agent,
                location
            ])

        except Exception as e:
            logger.error(f"[ERROR] Failed to log check-in attempt: {str(e)}")

    def _format_ticket_response(self, ticket: Dict[str, Any]) -> Dict[str, Any]:
        """Format ticket data for API response."""
        return {
            'id': ticket.get('id'),
            'ticket_uuid': str(ticket.get('ticket_uuid')) if ticket.get('ticket_uuid') else None,
            'ticket_code': ticket.get('ticket_code'),
            'ticket_number': ticket.get('ticket_number'),
            'event_id': ticket.get('event_id'),
            'event_title': ticket.get('event_title'),
            'ticket_type_id': ticket.get('ticket_type_id'),
            'ticket_type_name': ticket.get('ticket_type_name'),
            'holder_name': ticket.get('holder_name'),
            'holder_email': ticket.get('holder_email'),
            'username': ticket.get('username'),
            'platform': ticket.get('platform'),
            'status': ticket.get('status'),
            'is_checked_in': ticket.get('is_checked_in'),
            'checked_in_at': ticket.get('checked_in_at').isoformat()
            if ticket.get('checked_in_at') else None,
            'check_in_method': ticket.get('check_in_method'),
            'is_paid': ticket.get('is_paid'),
            'payment_status': ticket.get('payment_status'),
            'guest_number': ticket.get('guest_number'),
            'created_at': ticket.get('created_at').isoformat()
            if ticket.get('created_at') else None
        }
