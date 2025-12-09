"""
Slack Service - Slack API integration using slack_sdk
Handles all Slack API operations for pushing actions
"""
import json
import logging
from typing import Optional, Any
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError
from pydal import DAL, Field


logger = logging.getLogger(__name__)


class SlackService:
    """Slack API service using slack_sdk"""

    def __init__(self, bot_token: str, db: DAL):
        """
        Initialize Slack service

        Args:
            bot_token: Slack bot token
            db: PyDAL database instance
        """
        self.client = WebClient(token=bot_token)
        self.db = db
        self._define_tables()

    def _define_tables(self):
        """Define database tables for tracking Slack actions"""
        self.db.define_table(
            'slack_actions',
            Field('community_id', 'string', length=64, required=True),
            Field('action_type', 'string', length=64, required=True),
            Field('channel_id', 'string', length=64),
            Field('user_id', 'string', length=64),
            Field('message_ts', 'string', length=64),
            Field('request_data', 'json'),
            Field('response_data', 'json'),
            Field('success', 'boolean', default=True),
            Field('error_message', 'text'),
            Field('created_at', 'datetime', default='now')
        )

    async def send_message(
        self,
        community_id: str,
        channel_id: str,
        text: str,
        blocks: Optional[list[dict]] = None,
        thread_ts: Optional[str] = None
    ) -> dict:
        """
        Send message to Slack channel

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            text: Message text
            blocks: Optional Block Kit blocks
            thread_ts: Optional thread timestamp for replies

        Returns:
            Dict with success status, message_ts, and error if any
        """
        try:
            kwargs = {
                'channel': channel_id,
                'text': text
            }

            if blocks:
                kwargs['blocks'] = blocks

            if thread_ts:
                kwargs['thread_ts'] = thread_ts

            response = self.client.chat_postMessage(**kwargs)

            # Log action to database
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='send_message',
                channel_id=channel_id,
                message_ts=response['ts'],
                request_data={'text': text, 'blocks': blocks, 'thread_ts': thread_ts},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Sent message to channel {channel_id} in community {community_id}")
            return {
                'success': True,
                'message_ts': response['ts'],
                'error': None
            }

        except SlackApiError as e:
            logger.error(f"Failed to send message: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='send_message',
                channel_id=channel_id,
                request_data={'text': text, 'blocks': blocks},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {
                'success': False,
                'message_ts': None,
                'error': e.response['error']
            }

    async def send_ephemeral(
        self,
        community_id: str,
        channel_id: str,
        user_id: str,
        text: str
    ) -> dict:
        """
        Send ephemeral message (only visible to specific user)

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            user_id: Target user ID
            text: Message text

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=text
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='send_ephemeral',
                channel_id=channel_id,
                user_id=user_id,
                request_data={'text': text},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Sent ephemeral message to user {user_id} in channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to send ephemeral message: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='send_ephemeral',
                channel_id=channel_id,
                user_id=user_id,
                request_data={'text': text},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def update_message(
        self,
        community_id: str,
        channel_id: str,
        ts: str,
        text: str,
        blocks: Optional[list[dict]] = None
    ) -> dict:
        """
        Update existing message

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            ts: Message timestamp
            text: New message text
            blocks: Optional new Block Kit blocks

        Returns:
            Dict with success status and error if any
        """
        try:
            kwargs = {
                'channel': channel_id,
                'ts': ts,
                'text': text
            }

            if blocks:
                kwargs['blocks'] = blocks

            response = self.client.chat_update(**kwargs)

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='update_message',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'text': text, 'blocks': blocks},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Updated message {ts} in channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to update message: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='update_message',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'text': text, 'blocks': blocks},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def delete_message(
        self,
        community_id: str,
        channel_id: str,
        ts: str
    ) -> dict:
        """
        Delete message

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            ts: Message timestamp

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.chat_delete(
                channel=channel_id,
                ts=ts
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='delete_message',
                channel_id=channel_id,
                message_ts=ts,
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Deleted message {ts} from channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to delete message: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='delete_message',
                channel_id=channel_id,
                message_ts=ts,
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def add_reaction(
        self,
        community_id: str,
        channel_id: str,
        ts: str,
        emoji: str
    ) -> dict:
        """
        Add reaction to message

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            ts: Message timestamp
            emoji: Emoji name (without colons)

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.reactions_add(
                channel=channel_id,
                timestamp=ts,
                name=emoji
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='add_reaction',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'emoji': emoji},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Added reaction {emoji} to message {ts}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to add reaction: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='add_reaction',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'emoji': emoji},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def remove_reaction(
        self,
        community_id: str,
        channel_id: str,
        ts: str,
        emoji: str
    ) -> dict:
        """
        Remove reaction from message

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            ts: Message timestamp
            emoji: Emoji name (without colons)

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.reactions_remove(
                channel=channel_id,
                timestamp=ts,
                name=emoji
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='remove_reaction',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'emoji': emoji},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Removed reaction {emoji} from message {ts}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to remove reaction: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='remove_reaction',
                channel_id=channel_id,
                message_ts=ts,
                request_data={'emoji': emoji},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def upload_file(
        self,
        community_id: str,
        channel_id: str,
        file_content: bytes,
        filename: str,
        title: str
    ) -> dict:
        """
        Upload file to Slack channel

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            file_content: File content as bytes
            filename: Name of file
            title: File title

        Returns:
            Dict with success status, file_id, and error if any
        """
        try:
            response = self.client.files_upload_v2(
                channel=channel_id,
                file=file_content,
                filename=filename,
                title=title
            )

            file_id = response['file']['id']

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='upload_file',
                channel_id=channel_id,
                request_data={'filename': filename, 'title': title, 'size': len(file_content)},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Uploaded file {filename} to channel {channel_id}")
            return {'success': True, 'file_id': file_id, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to upload file: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='upload_file',
                channel_id=channel_id,
                request_data={'filename': filename, 'title': title},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'file_id': None, 'error': e.response['error']}

    async def create_channel(
        self,
        community_id: str,
        name: str,
        is_private: bool = False
    ) -> dict:
        """
        Create new channel

        Args:
            community_id: Community identifier
            name: Channel name
            is_private: Whether channel is private

        Returns:
            Dict with success status, channel_id, and error if any
        """
        try:
            if is_private:
                response = self.client.conversations_create(
                    name=name,
                    is_private=True
                )
            else:
                response = self.client.conversations_create(name=name)

            channel_id = response['channel']['id']

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='create_channel',
                channel_id=channel_id,
                request_data={'name': name, 'is_private': is_private},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Created channel {name} with ID {channel_id}")
            return {'success': True, 'channel_id': channel_id, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to create channel: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='create_channel',
                request_data={'name': name, 'is_private': is_private},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'channel_id': None, 'error': e.response['error']}

    async def invite_to_channel(
        self,
        community_id: str,
        channel_id: str,
        user_ids: list[str]
    ) -> dict:
        """
        Invite users to channel

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            user_ids: List of user IDs to invite

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.conversations_invite(
                channel=channel_id,
                users=','.join(user_ids)
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='invite_to_channel',
                channel_id=channel_id,
                request_data={'user_ids': user_ids},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Invited {len(user_ids)} users to channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to invite users: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='invite_to_channel',
                channel_id=channel_id,
                request_data={'user_ids': user_ids},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def kick_from_channel(
        self,
        community_id: str,
        channel_id: str,
        user_id: str
    ) -> dict:
        """
        Remove user from channel

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            user_id: User ID to remove

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.conversations_kick(
                channel=channel_id,
                user=user_id
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='kick_from_channel',
                channel_id=channel_id,
                user_id=user_id,
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Removed user {user_id} from channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to kick user: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='kick_from_channel',
                channel_id=channel_id,
                user_id=user_id,
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def set_topic(
        self,
        community_id: str,
        channel_id: str,
        topic: str
    ) -> dict:
        """
        Set channel topic

        Args:
            community_id: Community identifier
            channel_id: Slack channel ID
            topic: New channel topic

        Returns:
            Dict with success status and error if any
        """
        try:
            response = self.client.conversations_setTopic(
                channel=channel_id,
                topic=topic
            )

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='set_topic',
                channel_id=channel_id,
                request_data={'topic': topic},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Set topic for channel {channel_id}")
            return {'success': True, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to set topic: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='set_topic',
                channel_id=channel_id,
                request_data={'topic': topic},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'error': e.response['error']}

    async def open_modal(
        self,
        community_id: str,
        trigger_id: str,
        view: dict
    ) -> dict:
        """
        Open modal dialog

        Args:
            community_id: Community identifier
            trigger_id: Trigger ID from interaction
            view: Modal view object

        Returns:
            Dict with success status, view_id, and error if any
        """
        try:
            response = self.client.views_open(
                trigger_id=trigger_id,
                view=view
            )

            view_id = response['view']['id']

            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='open_modal',
                request_data={'trigger_id': trigger_id, 'view': view},
                response_data=response.data,
                success=True
            )
            self.db.commit()

            logger.info(f"Opened modal with view ID {view_id}")
            return {'success': True, 'view_id': view_id, 'error': None}

        except SlackApiError as e:
            logger.error(f"Failed to open modal: {e.response['error']}")
            self.db.slack_actions.insert(
                community_id=community_id,
                action_type='open_modal',
                request_data={'trigger_id': trigger_id},
                success=False,
                error_message=e.response['error']
            )
            self.db.commit()

            return {'success': False, 'view_id': None, 'error': e.response['error']}

    async def get_action_history(
        self,
        community_id: str,
        limit: int = 100
    ) -> list[dict]:
        """
        Get action history for community

        Args:
            community_id: Community identifier
            limit: Maximum number of records to return

        Returns:
            List of action records
        """
        rows = self.db(
            self.db.slack_actions.community_id == community_id
        ).select(
            orderby=~self.db.slack_actions.created_at,
            limitby=(0, limit)
        )

        return [row.as_dict() for row in rows]
