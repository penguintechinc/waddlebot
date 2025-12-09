"""
YouTube Data API v3 Integration Service
"""
import logging
from typing import Optional

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials

from config import Config
from services.oauth_manager import OAuthManager


logger = logging.getLogger(__name__)


class YouTubeService:
    """YouTube Data API v3 service for pushing actions"""

    def __init__(self, oauth_manager: OAuthManager):
        self.oauth_manager = oauth_manager

    def _get_client(self, channel_id: str):
        """
        Get authenticated YouTube API client

        Args:
            channel_id: YouTube channel ID

        Returns:
            YouTube API client
        """
        credentials = self.oauth_manager.get_credentials(channel_id)
        if not credentials:
            raise ValueError(f"No OAuth credentials for channel: {channel_id}")

        return build("youtube", Config.YOUTUBE_API_VERSION, credentials=credentials)

    # ========== Chat Management ==========

    def send_live_chat_message(
        self, live_chat_id: str, message: str, channel_id: str
    ) -> dict:
        """
        Send a message to YouTube live chat

        Args:
            live_chat_id: Live chat ID
            message: Message text
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            request = youtube.liveChatMessages().insert(
                part="snippet",
                body={
                    "snippet": {
                        "liveChatId": live_chat_id,
                        "type": "textMessageEvent",
                        "textMessageDetails": {"messageText": message},
                    }
                },
            )

            response = request.execute()

            logger.info(
                f"AUDIT channel={channel_id} action=send_chat_message "
                f"chat={live_chat_id} result=success"
            )

            return {
                "success": True,
                "message": "Message sent successfully",
                "message_id": response["id"],
            }

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=send_chat_message "
                f"error={e.resp.status} details={e.error_details}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=send_chat_message error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def delete_live_chat_message(self, message_id: str, channel_id: str) -> dict:
        """
        Delete a message from live chat

        Args:
            message_id: Message ID to delete
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)
            youtube.liveChatMessages().delete(id=message_id).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=delete_chat_message "
                f"message_id={message_id} result=success"
            )

            return {"success": True, "message": "Message deleted successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=delete_chat_message "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=delete_chat_message error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def ban_live_chat_user(
        self,
        live_chat_id: str,
        channel_id: str,
        target_channel_id: str,
        duration_seconds: Optional[int] = None,
    ) -> dict:
        """
        Ban a user from live chat

        Args:
            live_chat_id: Live chat ID
            channel_id: Channel ID for authentication
            target_channel_id: Channel ID of user to ban
            duration_seconds: Ban duration (None for permanent)

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            ban_body = {
                "snippet": {
                    "liveChatId": live_chat_id,
                    "type": "temporary" if duration_seconds else "permanent",
                    "bannedUserDetails": {"channelId": target_channel_id},
                }
            }

            if duration_seconds:
                ban_body["snippet"]["banDurationSeconds"] = duration_seconds

            youtube.liveChatBans().insert(part="snippet", body=ban_body).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=ban_user "
                f"target={target_channel_id} duration={duration_seconds} result=success"
            )

            return {"success": True, "message": "User banned successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=ban_user error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(f"ERROR channel={channel_id} action=ban_user error={str(e)}")
            return {"success": False, "message": str(e)}

    def unban_live_chat_user(
        self, live_chat_id: str, channel_id: str, target_channel_id: str
    ) -> dict:
        """
        Unban a user from live chat

        Args:
            live_chat_id: Live chat ID
            channel_id: Channel ID for authentication
            target_channel_id: Channel ID of user to unban

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            # List bans to find the ban ID
            bans = youtube.liveChatBans().list(
                part="snippet", liveChatId=live_chat_id
            ).execute()

            ban_id = None
            for ban in bans.get("items", []):
                if ban["snippet"]["bannedUserDetails"]["channelId"] == target_channel_id:
                    ban_id = ban["id"]
                    break

            if not ban_id:
                return {"success": False, "message": "User ban not found"}

            youtube.liveChatBans().delete(id=ban_id).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=unban_user "
                f"target={target_channel_id} result=success"
            )

            return {"success": True, "message": "User unbanned successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=unban_user error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(f"ERROR channel={channel_id} action=unban_user error={str(e)}")
            return {"success": False, "message": str(e)}

    # ========== Moderation ==========

    def add_moderator(
        self, live_chat_id: str, channel_id: str, target_channel_id: str
    ) -> dict:
        """
        Add a moderator to live chat

        Args:
            live_chat_id: Live chat ID
            channel_id: Channel ID for authentication
            target_channel_id: Channel ID of user to make moderator

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.liveChatModerators().insert(
                part="snippet",
                body={
                    "snippet": {
                        "liveChatId": live_chat_id,
                        "moderatorDetails": {"channelId": target_channel_id},
                    }
                },
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=add_moderator "
                f"target={target_channel_id} result=success"
            )

            return {"success": True, "message": "Moderator added successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=add_moderator error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=add_moderator error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def remove_moderator(
        self, live_chat_id: str, channel_id: str, target_channel_id: str
    ) -> dict:
        """
        Remove a moderator from live chat

        Args:
            live_chat_id: Live chat ID
            channel_id: Channel ID for authentication
            target_channel_id: Channel ID of moderator to remove

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_CHAT_ACTIONS:
            return {"success": False, "message": "Chat actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            # List moderators to find the moderator ID
            mods = youtube.liveChatModerators().list(
                part="snippet", liveChatId=live_chat_id
            ).execute()

            mod_id = None
            for mod in mods.get("items", []):
                if mod["snippet"]["moderatorDetails"]["channelId"] == target_channel_id:
                    mod_id = mod["id"]
                    break

            if not mod_id:
                return {"success": False, "message": "Moderator not found"}

            youtube.liveChatModerators().delete(id=mod_id).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=remove_moderator "
                f"target={target_channel_id} result=success"
            )

            return {"success": True, "message": "Moderator removed successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=remove_moderator "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=remove_moderator error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    # ========== Video Management ==========

    def update_video_title(self, video_id: str, title: str, channel_id: str) -> dict:
        """
        Update video title

        Args:
            video_id: Video ID
            title: New title
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_VIDEO_ACTIONS:
            return {"success": False, "message": "Video actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            # Get current video details
            video = youtube.videos().list(part="snippet", id=video_id).execute()

            if not video.get("items"):
                return {"success": False, "message": "Video not found"}

            video_data = video["items"][0]
            video_data["snippet"]["title"] = title

            youtube.videos().update(
                part="snippet", body={"id": video_id, "snippet": video_data["snippet"]}
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=update_title "
                f"video={video_id} result=success"
            )

            return {"success": True, "message": "Video title updated successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_title error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_title error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def update_video_description(
        self, video_id: str, description: str, channel_id: str
    ) -> dict:
        """
        Update video description

        Args:
            video_id: Video ID
            description: New description
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_VIDEO_ACTIONS:
            return {"success": False, "message": "Video actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            # Get current video details
            video = youtube.videos().list(part="snippet", id=video_id).execute()

            if not video.get("items"):
                return {"success": False, "message": "Video not found"}

            video_data = video["items"][0]
            video_data["snippet"]["description"] = description

            youtube.videos().update(
                part="snippet", body={"id": video_id, "snippet": video_data["snippet"]}
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=update_description "
                f"video={video_id} result=success"
            )

            return {"success": True, "message": "Video description updated"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_description "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_description error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    # ========== Playlist Management ==========

    def add_to_playlist(
        self, playlist_id: str, video_id: str, channel_id: str
    ) -> dict:
        """
        Add video to playlist

        Args:
            playlist_id: Playlist ID
            video_id: Video ID
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_PLAYLIST_ACTIONS:
            return {"success": False, "message": "Playlist actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.playlistItems().insert(
                part="snippet",
                body={
                    "snippet": {
                        "playlistId": playlist_id,
                        "resourceId": {"kind": "youtube#video", "videoId": video_id},
                    }
                },
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=add_to_playlist "
                f"playlist={playlist_id} video={video_id} result=success"
            )

            return {"success": True, "message": "Video added to playlist"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=add_to_playlist "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=add_to_playlist error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def remove_from_playlist(self, playlist_item_id: str, channel_id: str) -> dict:
        """
        Remove video from playlist

        Args:
            playlist_item_id: Playlist item ID
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_PLAYLIST_ACTIONS:
            return {"success": False, "message": "Playlist actions disabled"}

        try:
            youtube = self._get_client(channel_id)
            youtube.playlistItems().delete(id=playlist_item_id).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=remove_from_playlist "
                f"item={playlist_item_id} result=success"
            )

            return {"success": True, "message": "Video removed from playlist"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=remove_from_playlist "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=remove_from_playlist error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def create_playlist(
        self, title: str, description: str, privacy: str, channel_id: str
    ) -> dict:
        """
        Create new playlist

        Args:
            title: Playlist title
            description: Playlist description
            privacy: Privacy status (public, private, unlisted)
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary with playlist_id
        """
        if not Config.ENABLE_PLAYLIST_ACTIONS:
            return {"success": False, "message": "Playlist actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            response = youtube.playlists().insert(
                part="snippet,status",
                body={
                    "snippet": {"title": title, "description": description},
                    "status": {"privacyStatus": privacy},
                },
            ).execute()

            playlist_id = response["id"]

            logger.info(
                f"AUDIT channel={channel_id} action=create_playlist "
                f"playlist={playlist_id} result=success"
            )

            return {
                "success": True,
                "message": "Playlist created successfully",
                "playlist_id": playlist_id,
            }

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=create_playlist "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=create_playlist error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    # ========== Broadcast Management ==========

    def update_broadcast_status(
        self, broadcast_id: str, status: str, channel_id: str
    ) -> dict:
        """
        Update broadcast status (start/stop)

        Args:
            broadcast_id: Broadcast ID
            status: Status (testing, live, complete)
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_BROADCAST_ACTIONS:
            return {"success": False, "message": "Broadcast actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            if status == "live":
                youtube.liveBroadcasts().transition(
                    part="status", id=broadcast_id, broadcastStatus="live"
                ).execute()
            elif status == "complete":
                youtube.liveBroadcasts().transition(
                    part="status", id=broadcast_id, broadcastStatus="complete"
                ).execute()
            else:
                return {"success": False, "message": f"Invalid status: {status}"}

            logger.info(
                f"AUDIT channel={channel_id} action=update_broadcast_status "
                f"broadcast={broadcast_id} status={status} result=success"
            )

            return {"success": True, "message": f"Broadcast status updated to {status}"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_broadcast_status "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=update_broadcast_status "
                f"error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def insert_cuepoint(
        self, broadcast_id: str, duration_seconds: int, channel_id: str
    ) -> dict:
        """
        Insert ad break cuepoint

        Args:
            broadcast_id: Broadcast ID
            duration_seconds: Ad break duration
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_BROADCAST_ACTIONS:
            return {"success": False, "message": "Broadcast actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.liveBroadcasts().control(
                part="id,snippet,contentDetails,status",
                id=broadcast_id,
                onBehalfOfContentOwner="",
                onBehalfOfContentOwnerChannel="",
                displaySlate=True,
                offsetTimeMs=0,
                walltime="",
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=insert_cuepoint "
                f"broadcast={broadcast_id} duration={duration_seconds} result=success"
            )

            return {"success": True, "message": "Ad break inserted successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=insert_cuepoint "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=insert_cuepoint error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    # ========== Comment Management ==========

    def post_comment(self, video_id: str, text: str, channel_id: str) -> dict:
        """
        Post a comment on a video

        Args:
            video_id: Video ID
            text: Comment text
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_COMMENT_ACTIONS:
            return {"success": False, "message": "Comment actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.commentThreads().insert(
                part="snippet",
                body={
                    "snippet": {
                        "videoId": video_id,
                        "topLevelComment": {"snippet": {"textOriginal": text}},
                    }
                },
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=post_comment "
                f"video={video_id} result=success"
            )

            return {"success": True, "message": "Comment posted successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=post_comment error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=post_comment error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def reply_to_comment(self, parent_id: str, text: str, channel_id: str) -> dict:
        """
        Reply to a comment

        Args:
            parent_id: Parent comment ID
            text: Reply text
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_COMMENT_ACTIONS:
            return {"success": False, "message": "Comment actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.comments().insert(
                part="snippet",
                body={"snippet": {"parentId": parent_id, "textOriginal": text}},
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=reply_to_comment "
                f"parent={parent_id} result=success"
            )

            return {"success": True, "message": "Reply posted successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=reply_to_comment "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=reply_to_comment error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def delete_comment(self, comment_id: str, channel_id: str) -> dict:
        """
        Delete a comment

        Args:
            comment_id: Comment ID
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_COMMENT_ACTIONS:
            return {"success": False, "message": "Comment actions disabled"}

        try:
            youtube = self._get_client(channel_id)
            youtube.comments().delete(id=comment_id).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=delete_comment "
                f"comment={comment_id} result=success"
            )

            return {"success": True, "message": "Comment deleted successfully"}

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=delete_comment "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=delete_comment error={str(e)}"
            )
            return {"success": False, "message": str(e)}

    def set_comment_moderation(
        self, comment_id: str, status: str, channel_id: str
    ) -> dict:
        """
        Set comment moderation status

        Args:
            comment_id: Comment ID
            status: Moderation status (published, heldForReview, rejected)
            channel_id: Channel ID for authentication

        Returns:
            Result dictionary
        """
        if not Config.ENABLE_COMMENT_ACTIONS:
            return {"success": False, "message": "Comment actions disabled"}

        try:
            youtube = self._get_client(channel_id)

            youtube.comments().setModerationStatus(
                id=comment_id, moderationStatus=status
            ).execute()

            logger.info(
                f"AUDIT channel={channel_id} action=set_comment_moderation "
                f"comment={comment_id} status={status} result=success"
            )

            return {
                "success": True,
                "message": f"Comment moderation set to {status}",
            }

        except HttpError as e:
            logger.error(
                f"ERROR channel={channel_id} action=set_comment_moderation "
                f"error={e.resp.status}"
            )
            return {"success": False, "message": f"YouTube API error: {e.resp.status}"}
        except Exception as e:
            logger.error(
                f"ERROR channel={channel_id} action=set_comment_moderation "
                f"error={str(e)}"
            )
            return {"success": False, "message": str(e)}
