"""
RSVP Service - Stub implementation for Phase 1
Full implementation will be completed in Phase 2

This stub provides minimal working functionality to support app.py endpoints
"""
import logging
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)


class RSVPService:
    """
    RSVP service for event attendance management (Phase 1 stub).

    Phase 2 will implement:
    - Full RSVP functionality (yes/no/maybe)
    - Waitlist processing
    - Capacity checking
    - Guest count management
    """

    def __init__(self, dal):
        """Initialize RSVP service with database abstraction layer."""
        self.dal = dal

    async def rsvp_event(
        self,
        event_id: int,
        user_context: Dict[str, Any],
        rsvp_status: str = 'yes',
        guest_count: int = 0,
        user_note: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Create or update RSVP for event with capacity checking and waitlist.

        Args:
            event_id: Event ID
            user_context: User information
            rsvp_status: 'yes', 'no', or 'maybe'
            guest_count: Number of additional guests
            user_note: Optional note from user

        Returns:
            RSVP dict with keys: id, event_id, status, guest_count, is_waitlisted, message
        """
        try:
            # Check if RSVP already exists
            check_query = """
                SELECT id, is_waitlisted, waitlist_position FROM calendar_rsvps
                WHERE event_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            existing = await self.dal.execute(check_query, [
                event_id,
                user_context.get('platform'),
                user_context.get('platform_user_id')
            ])

            # Determine if user should be waitlisted (only for 'yes' RSVPs)
            is_waitlisted = False
            waitlist_position = None

            if rsvp_status == 'yes':
                is_full = await self.check_capacity(event_id)
                if is_full:
                    # Event is full - add to waitlist
                    is_waitlisted = True
                    # Get next waitlist position
                    pos_query = """
                        SELECT COALESCE(MAX(waitlist_position), 0) + 1 as next_pos
                        FROM calendar_rsvps
                        WHERE event_id = $1 AND is_waitlisted = true
                    """
                    pos_result = await self.dal.execute(pos_query, [event_id])
                    if pos_result and len(pos_result) > 0:
                        waitlist_position = pos_result[0].get('next_pos', 1)
                    else:
                        waitlist_position = 1

            if existing and len(existing) > 0:
                # Update existing RSVP
                query = """
                    UPDATE calendar_rsvps
                    SET rsvp_status = $1, guest_count = $2, user_note = $3,
                        is_waitlisted = $4, waitlist_position = $5, updated_at = NOW()
                    WHERE event_id = $6 AND platform = $7 AND platform_user_id = $8
                    RETURNING id, rsvp_status, guest_count, is_waitlisted, waitlist_position
                """
                result = await self.dal.execute(query, [
                    rsvp_status,
                    guest_count,
                    user_note,
                    is_waitlisted,
                    waitlist_position,
                    event_id,
                    user_context.get('platform'),
                    user_context.get('platform_user_id')
                ])
            else:
                # Create new RSVP
                query = """
                    INSERT INTO calendar_rsvps (
                        event_id, hub_user_id, platform, platform_user_id, username,
                        rsvp_status, guest_count, user_note, is_waitlisted, waitlist_position
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING id, rsvp_status, guest_count, is_waitlisted, waitlist_position
                """
                result = await self.dal.execute(query, [
                    event_id,
                    user_context.get('user_id'),
                    user_context.get('platform'),
                    user_context.get('platform_user_id'),
                    user_context.get('username'),
                    rsvp_status,
                    guest_count,
                    user_note,
                    is_waitlisted,
                    waitlist_position
                ])

            if result and len(result) > 0:
                # Update event attendance counts
                await self._update_event_counts(event_id)

                rsvp_data = result[0]
                message = 'RSVP updated successfully'
                if rsvp_data.get('is_waitlisted'):
                    message = f"Added to waitlist at position {rsvp_data.get('waitlist_position')}"

                logger.info(
                    f"[AUDIT] RSVP created/updated: event={event_id}, "
                    f"user={user_context.get('username')}, status={rsvp_status}, "
                    f"waitlisted={rsvp_data.get('is_waitlisted')}"
                )

                return {
                    'id': rsvp_data.get('id'),
                    'event_id': event_id,
                    'status': rsvp_data.get('rsvp_status'),
                    'guest_count': rsvp_data.get('guest_count'),
                    'is_waitlisted': rsvp_data.get('is_waitlisted'),
                    'waitlist_position': rsvp_data.get('waitlist_position'),
                    'message': message
                }
            else:
                return None

        except Exception as e:
            logger.error(f"[AUDIT] ERROR: RSVP failed: {e}")
            return None

    async def cancel_rsvp(
        self,
        event_id: int,
        user_context: Dict[str, Any]
    ) -> bool:
        """
        Cancel RSVP for event and process waitlist if spot opens.

        Args:
            event_id: Event ID
            user_context: User information

        Returns:
            True on success, False on failure
        """
        try:
            # Check if user was attending (not waitlisted) before deletion
            check_query = """
                SELECT is_waitlisted FROM calendar_rsvps
                WHERE event_id = $1 AND platform = $2 AND platform_user_id = $3
            """
            check_result = await self.dal.execute(check_query, [
                event_id,
                user_context.get('platform'),
                user_context.get('platform_user_id')
            ])

            was_attending = False
            if check_result and len(check_result) > 0:
                was_attending = not check_result[0].get('is_waitlisted', True)

            # Delete the RSVP
            query = """
                DELETE FROM calendar_rsvps
                WHERE event_id = $1 AND platform = $2 AND platform_user_id = $3
                RETURNING id
            """
            result = await self.dal.execute(query, [
                event_id,
                user_context.get('platform'),
                user_context.get('platform_user_id')
            ])

            if result and len(result) > 0:
                # Update event attendance counts
                await self._update_event_counts(event_id)

                # If user was attending (not waitlisted), process waitlist to fill spot
                if was_attending:
                    promoted = await self.process_waitlist(event_id)
                    if promoted > 0:
                        logger.info(f"Promoted {promoted} user(s) from waitlist after cancellation")

                logger.info(
                    f"[AUDIT] RSVP cancelled: event={event_id}, "
                    f"user={user_context.get('username')}"
                )
                return True
            else:
                return False

        except Exception as e:
            logger.error(f"[AUDIT] ERROR: Cancel RSVP failed: {e}")
            return False

    async def get_attendees(
        self,
        event_id: int,
        status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Get attendee list for event (stub).

        Args:
            event_id: Event ID
            status: Optional filter by RSVP status (yes/no/maybe)

        Returns:
            List of attendee dicts
        """
        try:
            if status:
                query = """
                    SELECT
                        hub_user_id, platform, platform_user_id, username,
                        rsvp_status, guest_count, user_note, is_waitlisted,
                        waitlist_position, created_at
                    FROM calendar_rsvps
                    WHERE event_id = $1 AND rsvp_status = $2
                    ORDER BY created_at ASC
                """
                rows = await self.dal.execute(query, [event_id, status])
            else:
                query = """
                    SELECT
                        hub_user_id, platform, platform_user_id, username,
                        rsvp_status, guest_count, user_note, is_waitlisted,
                        waitlist_position, created_at
                    FROM calendar_rsvps
                    WHERE event_id = $1
                    ORDER BY created_at ASC
                """
                rows = await self.dal.execute(query, [event_id])

            attendees = []
            for row in rows:
                attendees.append({
                    'hub_user_id': row['hub_user_id'],
                    'platform': row['platform'],
                    'platform_user_id': row['platform_user_id'],
                    'username': row['username'],
                    'rsvp_status': row['rsvp_status'],
                    'guest_count': row['guest_count'],
                    'user_note': row['user_note'],
                    'is_waitlisted': row['is_waitlisted'],
                    'waitlist_position': row['waitlist_position'],
                    'joined_at': row['created_at'].isoformat() if row['created_at'] else None
                })

            return attendees

        except Exception as e:
            logger.error(f"[AUDIT] ERROR: Get attendees failed: {e}")
            return []

    async def _update_event_counts(self, event_id: int) -> None:
        """
        Update event attendance counts (internal helper).

        Args:
            event_id: Event ID
        """
        try:
            # Count RSVPs by status
            query = """
                UPDATE calendar_events
                SET
                    attending_count = (
                        SELECT COUNT(*) FROM calendar_rsvps
                        WHERE event_id = $1 AND rsvp_status = 'yes'
                    ),
                    interested_count = (
                        SELECT COUNT(*) FROM calendar_rsvps
                        WHERE event_id = $2 AND rsvp_status = 'maybe'
                    ),
                    declined_count = (
                        SELECT COUNT(*) FROM calendar_rsvps
                        WHERE event_id = $3 AND rsvp_status = 'no'
                    ),
                    updated_at = NOW()
                WHERE id = $4
            """
            await self.dal.execute(query, [event_id, event_id, event_id, event_id])

        except Exception as e:
            # Don't fail the operation if count update fails
            logger.warning(f"Failed to update event counts: {e}")

    async def check_capacity(self, event_id: int) -> bool:
        """
        Check if event is at capacity.

        Args:
            event_id: Event ID to check

        Returns:
            True if event is at capacity, False otherwise
        """
        try:
            # Get event details with max_attendees and current counts
            query = """
                SELECT max_attendees, attending_count
                FROM calendar_events
                WHERE id = $1
            """
            result = await self.dal.execute(query, [event_id])

            if not result or len(result) == 0:
                logger.warning(f"Event {event_id} not found for capacity check")
                return False

            event = result[0]
            max_attendees = event.get('max_attendees')

            # If no max_attendees set, unlimited capacity
            if max_attendees is None or max_attendees == 0:
                return False

            attending_count = event.get('attending_count', 0)

            # Check if at or over capacity
            is_full = attending_count >= max_attendees

            logger.debug(
                f"Capacity check for event {event_id}: "
                f"{attending_count}/{max_attendees} (full={is_full})"
            )

            return is_full

        except Exception as e:
            logger.error(f"Error checking capacity: {e}")
            return False

    async def process_waitlist(self, event_id: int) -> int:
        """
        Process waitlist for event - promote users from waitlist when spots open.

        Args:
            event_id: Event ID

        Returns:
            Number of users promoted from waitlist
        """
        try:
            # Check if event has capacity and is not full
            is_full = await self.check_capacity(event_id)
            if is_full:
                logger.debug(f"Event {event_id} still at capacity, no waitlist processing")
                return 0

            # Get event max_attendees and current counts
            event_query = """
                SELECT max_attendees, attending_count
                FROM calendar_events
                WHERE id = $1
            """
            event_result = await self.dal.execute(event_query, [event_id])

            if not event_result or len(event_result) == 0:
                return 0

            event = event_result[0]
            max_attendees = event.get('max_attendees')

            if max_attendees is None or max_attendees == 0:
                # Unlimited capacity - promote all waitlisted
                available_spots = 999999
            else:
                attending_count = event.get('attending_count', 0)
                available_spots = max_attendees - attending_count

            if available_spots <= 0:
                return 0

            # Get waitlisted RSVPs ordered by waitlist_position
            waitlist_query = """
                SELECT id, platform, platform_user_id, username, waitlist_position
                FROM calendar_rsvps
                WHERE event_id = $1 AND is_waitlisted = true
                ORDER BY waitlist_position ASC
                LIMIT $2
            """
            waitlisted = await self.dal.execute(waitlist_query, [event_id, available_spots])

            promoted_count = 0
            for rsvp in waitlisted:
                # Promote from waitlist
                update_query = """
                    UPDATE calendar_rsvps
                    SET is_waitlisted = false, waitlist_position = NULL, updated_at = NOW()
                    WHERE id = $1
                """
                await self.dal.execute(update_query, [rsvp['id']])

                logger.info(
                    f"[AUDIT] Promoted from waitlist: event={event_id}, "
                    f"user={rsvp['username']}, position={rsvp['waitlist_position']}"
                )

                promoted_count += 1

            # Update event counts
            if promoted_count > 0:
                await self._update_event_counts(event_id)

            logger.info(f"Processed waitlist for event {event_id}: promoted {promoted_count} users")
            return promoted_count

        except Exception as e:
            logger.error(f"Error processing waitlist: {e}")
            return 0

    async def get_rsvp_counts(self, event_id: int) -> Dict[str, int]:
        """
        Get RSVP counts by status.

        Args:
            event_id: Event ID

        Returns:
            Dict with counts: {'yes': N, 'no': N, 'maybe': N, 'waitlisted': N}
        """
        try:
            query = """
                SELECT
                    COUNT(*) FILTER (WHERE rsvp_status = 'yes' AND is_waitlisted = false) as yes_count,
                    COUNT(*) FILTER (WHERE rsvp_status = 'no') as no_count,
                    COUNT(*) FILTER (WHERE rsvp_status = 'maybe') as maybe_count,
                    COUNT(*) FILTER (WHERE is_waitlisted = true) as waitlisted_count
                FROM calendar_rsvps
                WHERE event_id = $1
            """
            result = await self.dal.execute(query, [event_id])

            if result and len(result) > 0:
                row = result[0]
                return {
                    'yes': row.get('yes_count', 0),
                    'no': row.get('no_count', 0),
                    'maybe': row.get('maybe_count', 0),
                    'waitlisted': row.get('waitlisted_count', 0)
                }
            else:
                return {'yes': 0, 'no': 0, 'maybe': 0, 'waitlisted': 0}

        except Exception as e:
            logger.error(f"Error getting RSVP counts: {e}")
            return {'yes': 0, 'no': 0, 'maybe': 0, 'waitlisted': 0}
