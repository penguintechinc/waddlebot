"""
Reminder Service

Manages user reminders with support for one-time and recurring reminders.
"""

import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from dateutil.rrule import rrulestr, rrule
import pytz

logger = logging.getLogger(__name__)


class ReminderService:
    """
    Service for managing user reminders.

    Features:
    - One-time reminders
    - Recurring reminders (RRULE format)
    - Channel-specific delivery
    - Pending reminder queries
    - Reminder cancellation
    """

    def __init__(self, dal):
        """
        Initialize reminder service.

        Args:
            dal: Database access layer
        """
        self.dal = dal

    async def create_reminder(
        self,
        community_id: int,
        user_id: int,
        username: str,
        reminder_text: str,
        remind_at: datetime,
        channel: str = 'twitch',
        platform_channel_id: Optional[str] = None,
        recurring_rule: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create a new reminder.

        Args:
            community_id: Community ID
            user_id: User ID to remind
            username: Username to remind
            reminder_text: Reminder message
            remind_at: When to send reminder (UTC)
            channel: Platform channel (twitch, discord, slack)
            platform_channel_id: Platform-specific channel ID
            recurring_rule: RRULE format for recurring reminders

        Returns:
            Reminder dictionary with ID
        """
        try:
            # Validate remind_at is in the future
            if remind_at <= datetime.utcnow():
                raise ValueError("remind_at must be in the future")

            # Validate recurring rule if provided
            if recurring_rule:
                try:
                    # Test parse RRULE
                    rrulestr(recurring_rule, dtstart=remind_at)
                except Exception as e:
                    raise ValueError(f"Invalid recurring_rule: {e}")

            result = self.dal.executesql(
                """INSERT INTO memories_reminders
                   (community_id, user_id, username, reminder_text, remind_at,
                    recurring_rule, channel, platform_channel_id, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                [
                    community_id,
                    user_id,
                    username,
                    reminder_text,
                    remind_at,
                    recurring_rule,
                    channel,
                    platform_channel_id,
                    datetime.utcnow()
                ]
            )

            if result and result[0]:
                reminder_id = result[0][0]
                logger.info(
                    f"Reminder {reminder_id} created for user {username} "
                    f"in community {community_id}"
                )
                return {
                    'id': reminder_id,
                    'user_id': user_id,
                    'username': username,
                    'reminder_text': reminder_text,
                    'remind_at': remind_at.isoformat(),
                    'recurring_rule': recurring_rule,
                    'channel': channel,
                    'is_recurring': bool(recurring_rule)
                }

            raise Exception("Failed to insert reminder")

        except Exception as e:
            logger.error(f"Failed to create reminder: {e}")
            raise

    async def get_pending_reminders(
        self,
        community_id: Optional[int] = None,
        before: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """
        Get pending reminders that need to be sent.

        Args:
            community_id: Filter by community (optional)
            before: Get reminders before this time (default: now)

        Returns:
            List of pending reminder dictionaries
        """
        try:
            if before is None:
                before = datetime.utcnow()

            conditions = [
                "is_sent = FALSE",
                "is_active = TRUE",
                "remind_at <= %s"
            ]
            params = [before]

            if community_id:
                conditions.append("community_id = %s")
                params.append(community_id)

            where_clause = " AND ".join(conditions)

            result = self.dal.executesql(
                f"""SELECT id, community_id, user_id, username, reminder_text,
                           remind_at, recurring_rule, channel, platform_channel_id
                    FROM memories_reminders
                    WHERE {where_clause}
                    ORDER BY remind_at ASC""",
                params
            )

            return [
                {
                    'id': row[0],
                    'community_id': row[1],
                    'user_id': row[2],
                    'username': row[3],
                    'reminder_text': row[4],
                    'remind_at': row[5].isoformat() if row[5] else None,
                    'recurring_rule': row[6],
                    'channel': row[7],
                    'platform_channel_id': row[8],
                    'is_recurring': bool(row[6])
                }
                for row in result
            ]

        except Exception as e:
            logger.error(f"Failed to get pending reminders: {e}")
            return []

    async def mark_reminder_sent(
        self,
        reminder_id: int,
        schedule_next: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Mark reminder as sent and optionally schedule next occurrence.

        Args:
            reminder_id: Reminder ID
            schedule_next: If recurring, schedule next occurrence

        Returns:
            Next reminder if recurring, None otherwise
        """
        try:
            # Get reminder details
            result = self.dal.executesql(
                """SELECT community_id, user_id, username, reminder_text,
                          remind_at, recurring_rule, channel, platform_channel_id
                   FROM memories_reminders
                   WHERE id = %s""",
                [reminder_id]
            )

            if not result or not result[0]:
                logger.warning(f"Reminder {reminder_id} not found")
                return None

            row = result[0]
            community_id = row[0]
            user_id = row[1]
            username = row[2]
            reminder_text = row[3]
            remind_at = row[4]
            recurring_rule = row[5]
            channel = row[6]
            platform_channel_id = row[7]

            # Mark as sent
            self.dal.executesql(
                """UPDATE memories_reminders
                   SET is_sent = TRUE, sent_at = %s
                   WHERE id = %s""",
                [datetime.utcnow(), reminder_id]
            )

            logger.info(f"Reminder {reminder_id} marked as sent")

            # If recurring, schedule next occurrence
            if recurring_rule and schedule_next:
                try:
                    # Parse RRULE and get next occurrence
                    rule = rrulestr(recurring_rule, dtstart=remind_at)
                    next_occurrence = rule.after(datetime.utcnow())

                    if next_occurrence:
                        # Create new reminder for next occurrence
                        next_reminder = await self.create_reminder(
                            community_id=community_id,
                            user_id=user_id,
                            username=username,
                            reminder_text=reminder_text,
                            remind_at=next_occurrence,
                            channel=channel,
                            platform_channel_id=platform_channel_id,
                            recurring_rule=recurring_rule
                        )
                        logger.info(
                            f"Scheduled next occurrence of reminder: "
                            f"{next_reminder['id']} at {next_occurrence}"
                        )
                        return next_reminder

                except Exception as e:
                    logger.error(
                        f"Failed to schedule next occurrence for reminder "
                        f"{reminder_id}: {e}"
                    )

            return None

        except Exception as e:
            logger.error(f"Failed to mark reminder sent: {e}")
            return None

    async def get_user_reminders(
        self,
        community_id: int,
        user_id: int,
        include_sent: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Get all reminders for a user.

        Args:
            community_id: Community ID
            user_id: User ID
            include_sent: Include already sent reminders

        Returns:
            List of reminder dictionaries
        """
        try:
            conditions = [
                "community_id = %s",
                "user_id = %s",
                "is_active = TRUE"
            ]
            params = [community_id, user_id]

            if not include_sent:
                conditions.append("is_sent = FALSE")

            where_clause = " AND ".join(conditions)

            result = self.dal.executesql(
                f"""SELECT id, reminder_text, remind_at, recurring_rule,
                           channel, is_sent, sent_at, created_at
                    FROM memories_reminders
                    WHERE {where_clause}
                    ORDER BY remind_at ASC""",
                params
            )

            return [
                {
                    'id': row[0],
                    'reminder_text': row[1],
                    'remind_at': row[2].isoformat() if row[2] else None,
                    'recurring_rule': row[3],
                    'channel': row[4],
                    'is_sent': row[5],
                    'sent_at': row[6].isoformat() if row[6] else None,
                    'created_at': row[7].isoformat() if row[7] else None,
                    'is_recurring': bool(row[3])
                }
                for row in result
            ]

        except Exception as e:
            logger.error(f"Failed to get user reminders: {e}")
            return []

    async def cancel_reminder(
        self,
        community_id: int,
        reminder_id: int,
        user_id: int
    ) -> bool:
        """
        Cancel a reminder.

        Args:
            community_id: Community ID
            reminder_id: Reminder ID to cancel
            user_id: User requesting cancellation (must be owner)

        Returns:
            True if successful
        """
        try:
            # Check if user owns this reminder
            result = self.dal.executesql(
                """SELECT user_id FROM memories_reminders
                   WHERE id = %s AND community_id = %s""",
                [reminder_id, community_id]
            )

            if not result or not result[0]:
                logger.warning(f"Reminder {reminder_id} not found")
                return False

            owner_id = result[0][0]
            if owner_id != user_id:
                logger.warning(
                    f"User {user_id} not authorized to cancel reminder "
                    f"{reminder_id}"
                )
                return False

            # Mark as inactive
            self.dal.executesql(
                """UPDATE memories_reminders
                   SET is_active = FALSE
                   WHERE id = %s AND community_id = %s""",
                [reminder_id, community_id]
            )

            logger.info(f"Reminder {reminder_id} cancelled by user {user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to cancel reminder: {e}")
            return False

    async def parse_relative_time(
        self,
        time_str: str,
        base_time: Optional[datetime] = None
    ) -> datetime:
        """
        Parse relative time string to datetime.

        Args:
            time_str: Time string like "5m", "2h", "1d", "3w"
            base_time: Base time (default: now)

        Returns:
            Datetime object

        Examples:
            "5m" -> 5 minutes from now
            "2h" -> 2 hours from now
            "1d" -> 1 day from now
            "3w" -> 3 weeks from now
        """
        if base_time is None:
            base_time = datetime.utcnow()

        time_str = time_str.strip().lower()

        # Parse time amount and unit
        if not time_str[-1].isalpha():
            raise ValueError("Time string must end with a unit (m/h/d/w)")

        unit = time_str[-1]
        try:
            amount = int(time_str[:-1])
        except ValueError:
            raise ValueError("Invalid time amount")

        # Calculate timedelta
        if unit == 'm':
            delta = timedelta(minutes=amount)
        elif unit == 'h':
            delta = timedelta(hours=amount)
        elif unit == 'd':
            delta = timedelta(days=amount)
        elif unit == 'w':
            delta = timedelta(weeks=amount)
        else:
            raise ValueError(f"Invalid time unit: {unit}")

        return base_time + delta

    async def get_stats(self, community_id: int) -> Dict[str, Any]:
        """
        Get reminder statistics for community.

        Args:
            community_id: Community ID

        Returns:
            Statistics dictionary
        """
        try:
            result = self.dal.executesql(
                """SELECT
                       COUNT(*) FILTER (WHERE is_sent = FALSE AND is_active = TRUE) as pending,
                       COUNT(*) FILTER (WHERE is_sent = TRUE) as sent,
                       COUNT(*) FILTER (WHERE recurring_rule IS NOT NULL) as recurring,
                       COUNT(DISTINCT user_id) as unique_users
                   FROM memories_reminders
                   WHERE community_id = %s""",
                [community_id]
            )

            if result and result[0]:
                row = result[0]
                return {
                    'pending_reminders': row[0] or 0,
                    'sent_reminders': row[1] or 0,
                    'recurring_reminders': row[2] or 0,
                    'unique_users': row[3] or 0
                }

            return {
                'pending_reminders': 0,
                'sent_reminders': 0,
                'recurring_reminders': 0,
                'unique_users': 0
            }

        except Exception as e:
            logger.error(f"Failed to get reminder stats: {e}")
            return {
                'pending_reminders': 0,
                'sent_reminders': 0,
                'recurring_reminders': 0,
                'unique_users': 0
            }
