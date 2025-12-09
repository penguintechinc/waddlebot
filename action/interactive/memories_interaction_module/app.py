"""
Community Memories - Quart Application

Manages quotes, bookmarks, and reminders for communities.
"""
import asyncio
import os
import sys
from datetime import datetime

from quart import Blueprint, Quart

# Setup path for flask_core import
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'libs'))  # noqa: E402

from flask_core import (  # noqa: E402
    async_endpoint,
    auth_required,
    create_health_blueprint,
    error_response,
    init_database,
    setup_aaa_logging,
    success_response
)
from flask_core.validation import validate_json, validate_query  # noqa: E402
from config import Config  # noqa: E402
from services.quote_service import QuoteService  # noqa: E402
from services.bookmark_service import BookmarkService  # noqa: E402
from services.reminder_service import ReminderService  # noqa: E402
from validation_models import (  # noqa: E402
    QuoteCreateRequest,
    QuoteSearchParams,
    QuoteVoteRequest,
    QuoteDeleteRequest,
    BookmarkCreateRequest,
    BookmarkSearchParams,
    BookmarkDeleteRequest,
    PopularBookmarksParams,
    ReminderCreateRequest,
    ReminderSearchParams,
    ReminderMarkSentRequest,
    ReminderDeleteRequest,
    UserRemindersParams,
)

app = Quart(__name__)

# Register health/metrics endpoints
health_bp = create_health_blueprint(Config.MODULE_NAME, Config.MODULE_VERSION)
app.register_blueprint(health_bp)

api_bp = Blueprint('api', __name__, url_prefix='/api/v1')
logger = setup_aaa_logging(Config.MODULE_NAME, Config.MODULE_VERSION)

dal = None
quote_service = None
bookmark_service = None
reminder_service = None


@app.before_serving
async def startup():
    global dal, quote_service, bookmark_service, reminder_service
    logger.system("Starting memories_interaction_module", action="startup")

    dal = init_database(Config.DATABASE_URL)
    app.config['dal'] = dal

    # Initialize services
    quote_service = QuoteService(dal)
    bookmark_service = BookmarkService(dal)
    reminder_service = ReminderService(dal)

    logger.system("memories_interaction_module started", result="SUCCESS")


@api_bp.route('/status')
@async_endpoint
async def status():
    return success_response({
        "status": "operational",
        "module": Config.MODULE_NAME,
        "version": Config.MODULE_VERSION
    })


# ============================================================================
# QUOTE ENDPOINTS
# ============================================================================

@api_bp.route('/quotes', methods=['POST'])
@validate_json(QuoteCreateRequest)
@async_endpoint
async def add_quote(validated_data: QuoteCreateRequest):
    """
    Add a new quote.

    Request JSON:
    {
        "community_id": 123,
        "quote_text": "Amazing quote here",
        "created_by_username": "username",
        "created_by_user_id": 456,
        "author_username": "quoted_user",
        "author_user_id": 789,
        "category": "funny"
    }
    """
    try:
        quote = await quote_service.add_quote(
            community_id=validated_data.community_id,
            quote_text=validated_data.quote_text,
            created_by_username=validated_data.created_by_username,
            created_by_user_id=validated_data.created_by_user_id,
            author_username=validated_data.author_username,
            author_user_id=validated_data.author_user_id,
            category=validated_data.category
        )

        logger.audit(
            action="add_quote",
            community=validated_data.community_id,
            user=validated_data.created_by_username,
            result="SUCCESS"
        )

        return success_response(quote)

    except Exception as e:
        logger.error(f"Failed to add quote: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>', methods=['GET'])
@validate_query(QuoteSearchParams)
@async_endpoint
async def search_quotes(query_params: QuoteSearchParams, community_id: int):
    """
    Search quotes.

    Query params:
    - q: Search query (optional)
    - category: Category filter (optional)
    - author: Author filter (optional)
    - limit: Results limit (default 50)
    - offset: Pagination offset (default 0)
    """
    try:
        quotes = await quote_service.search_quotes(
            community_id=community_id,
            search_query=query_params.search_query,
            category=query_params.category,
            author=query_params.author,
            limit=query_params.limit,
            offset=query_params.offset
        )

        return success_response({'quotes': quotes, 'count': len(quotes)})

    except Exception as e:
        logger.error(f"Failed to search quotes: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/random', methods=['GET'])
@async_endpoint
async def get_random_quote(community_id: int):
    """Get random quote from community."""
    try:
        quote = await quote_service.get_quote(community_id)
        if quote:
            return success_response(quote)
        return error_response("No quotes found", status_code=404)

    except Exception as e:
        logger.error(f"Failed to get random quote: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/<int:quote_id>', methods=['GET'])
@async_endpoint
async def get_quote(community_id: int, quote_id: int):
    """Get specific quote by ID."""
    try:
        quote = await quote_service.get_quote(community_id, quote_id)
        if quote:
            return success_response(quote)
        return error_response("Quote not found", status_code=404)

    except Exception as e:
        logger.error(f"Failed to get quote: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/<int:quote_id>', methods=['DELETE'])
@auth_required
@validate_json(QuoteDeleteRequest)
@async_endpoint
async def delete_quote(validated_data: QuoteDeleteRequest, community_id: int, quote_id: int):
    """Delete a quote (must be creator)."""
    try:
        success = await quote_service.delete_quote(
            community_id, quote_id, validated_data.user_id
        )

        if success:
            return success_response({"message": "Quote deleted"})
        return error_response("Unauthorized or not found", status_code=403)

    except Exception as e:
        logger.error(f"Failed to delete quote: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/<int:quote_id>/vote', methods=['POST'])
@validate_json(QuoteVoteRequest)
@async_endpoint
async def vote_quote(validated_data: QuoteVoteRequest, community_id: int, quote_id: int):
    """
    Vote on a quote.

    Request JSON:
    {
        "user_id": 123,
        "username": "voter",
        "vote_type": "up"  // or "down"
    }
    """
    try:
        result = await quote_service.vote_quote(
            community_id, quote_id, validated_data.user_id,
            validated_data.username, validated_data.vote_type
        )

        return success_response(result)

    except Exception as e:
        logger.error(f"Failed to vote on quote: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/categories', methods=['GET'])
@async_endpoint
async def get_quote_categories(community_id: int):
    """Get all quote categories for community."""
    try:
        categories = await quote_service.get_categories(community_id)
        return success_response({'categories': categories})

    except Exception as e:
        logger.error(f"Failed to get categories: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/quotes/<int:community_id>/stats', methods=['GET'])
@async_endpoint
async def get_quote_stats(community_id: int):
    """Get quote statistics."""
    try:
        stats = await quote_service.get_stats(community_id)
        return success_response(stats)

    except Exception as e:
        logger.error(f"Failed to get stats: {e}")
        return error_response(str(e), status_code=500)


# ============================================================================
# BOOKMARK ENDPOINTS
# ============================================================================

@api_bp.route('/bookmarks', methods=['POST'])
@validate_json(BookmarkCreateRequest)
@async_endpoint
async def add_bookmark(validated_data: BookmarkCreateRequest):
    """
    Add a new bookmark.

    Request JSON:
    {
        "community_id": 123,
        "url": "https://example.com",
        "created_by_username": "username",
        "created_by_user_id": 456,
        "title": "Example Site",
        "description": "A great example",
        "tags": ["example", "test"],
        "auto_fetch_metadata": true
    }
    """
    try:
        bookmark = await bookmark_service.add_bookmark(
            community_id=validated_data.community_id,
            url=validated_data.url,
            created_by_username=validated_data.created_by_username,
            created_by_user_id=validated_data.created_by_user_id,
            title=validated_data.title,
            description=validated_data.description,
            tags=validated_data.tags,
            auto_fetch_metadata=validated_data.auto_fetch_metadata
        )

        logger.audit(
            action="add_bookmark",
            community=validated_data.community_id,
            user=validated_data.created_by_username,
            result="SUCCESS"
        )

        return success_response(bookmark)

    except Exception as e:
        logger.error(f"Failed to add bookmark: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>', methods=['GET'])
@validate_query(BookmarkSearchParams)
@async_endpoint
async def search_bookmarks(query_params: BookmarkSearchParams, community_id: int):
    """
    Search bookmarks.

    Query params:
    - q: Search query (optional)
    - tags: Comma-separated tags (optional)
    - created_by: Creator filter (optional)
    - limit: Results limit (default 50)
    - offset: Pagination offset (default 0)
    """
    try:
        # Parse tags if provided as comma-separated string
        tags = query_params.tags
        if tags and isinstance(tags, str):
            tags = [tag.strip() for tag in tags.split(',') if tag.strip()]

        bookmarks = await bookmark_service.search_bookmarks(
            community_id=community_id,
            search_query=query_params.search_query,
            tags=tags,
            created_by=query_params.created_by,
            limit=query_params.limit,
            offset=query_params.offset
        )

        return success_response({'bookmarks': bookmarks, 'count': len(bookmarks)})

    except Exception as e:
        logger.error(f"Failed to search bookmarks: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>/<int:bookmark_id>', methods=['GET'])
@async_endpoint
async def get_bookmark(community_id: int, bookmark_id: int):
    """Get specific bookmark and increment visit count."""
    try:
        bookmark = await bookmark_service.get_bookmark(community_id, bookmark_id)
        if bookmark:
            # Increment visit count
            await bookmark_service.increment_visits(community_id, bookmark_id)
            return success_response(bookmark)
        return error_response("Bookmark not found", status_code=404)

    except Exception as e:
        logger.error(f"Failed to get bookmark: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>/<int:bookmark_id>', methods=['DELETE'])
@auth_required
@validate_json(BookmarkDeleteRequest)
@async_endpoint
async def delete_bookmark(validated_data: BookmarkDeleteRequest, community_id: int, bookmark_id: int):
    """Delete a bookmark (must be creator)."""
    try:
        success = await bookmark_service.delete_bookmark(
            community_id, bookmark_id, validated_data.user_id
        )

        if success:
            return success_response({"message": "Bookmark deleted"})
        return error_response("Unauthorized or not found", status_code=403)

    except Exception as e:
        logger.error(f"Failed to delete bookmark: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>/popular', methods=['GET'])
@validate_query(PopularBookmarksParams)
@async_endpoint
async def get_popular_bookmarks(query_params: PopularBookmarksParams, community_id: int):
    """Get most visited bookmarks."""
    try:
        bookmarks = await bookmark_service.get_popular_bookmarks(
            community_id, query_params.limit
        )
        return success_response({'bookmarks': bookmarks})

    except Exception as e:
        logger.error(f"Failed to get popular bookmarks: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>/tags', methods=['GET'])
@async_endpoint
async def get_bookmark_tags(community_id: int):
    """Get all bookmark tags for community."""
    try:
        tags = await bookmark_service.get_all_tags(community_id)
        return success_response({'tags': tags})

    except Exception as e:
        logger.error(f"Failed to get tags: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/bookmarks/<int:community_id>/stats', methods=['GET'])
@async_endpoint
async def get_bookmark_stats(community_id: int):
    """Get bookmark statistics."""
    try:
        stats = await bookmark_service.get_stats(community_id)
        return success_response(stats)

    except Exception as e:
        logger.error(f"Failed to get stats: {e}")
        return error_response(str(e), status_code=500)


# ============================================================================
# REMINDER ENDPOINTS
# ============================================================================

@api_bp.route('/reminders', methods=['POST'])
@validate_json(ReminderCreateRequest)
@async_endpoint
async def create_reminder(validated_data: ReminderCreateRequest):
    """
    Create a new reminder.

    Request JSON:
    {
        "community_id": 123,
        "user_id": 456,
        "username": "user",
        "reminder_text": "Don't forget!",
        "remind_in": "5m",  // or ISO timestamp
        "channel": "twitch",
        "platform_channel_id": "12345",
        "recurring_rule": "FREQ=DAILY;INTERVAL=1"  // optional RRULE
    }
    """
    try:
        # Parse remind_in (relative time or ISO timestamp)
        try:
            # Try parsing as ISO timestamp
            remind_at = datetime.fromisoformat(validated_data.remind_in.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            # Parse as relative time (5m, 2h, 1d, etc.)
            remind_at = await reminder_service.parse_relative_time(validated_data.remind_in)

        reminder = await reminder_service.create_reminder(
            community_id=validated_data.community_id,
            user_id=validated_data.user_id,
            username=validated_data.username,
            reminder_text=validated_data.reminder_text,
            remind_at=remind_at,
            channel=validated_data.channel,
            platform_channel_id=validated_data.platform_channel_id,
            recurring_rule=validated_data.recurring_rule
        )

        logger.audit(
            action="create_reminder",
            community=validated_data.community_id,
            user=validated_data.username,
            result="SUCCESS"
        )

        return success_response(reminder)

    except Exception as e:
        logger.error(f"Failed to create reminder: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/reminders/pending', methods=['GET'])
@auth_required
@validate_query(ReminderSearchParams)
@async_endpoint
async def get_pending_reminders(query_params: ReminderSearchParams):
    """
    Get pending reminders (for reminder processor).

    Query params:
    - community_id: Filter by community (optional)
    """
    try:
        reminders = await reminder_service.get_pending_reminders(query_params.community_id)
        return success_response({'reminders': reminders, 'count': len(reminders)})

    except Exception as e:
        logger.error(f"Failed to get pending reminders: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/reminders/<int:reminder_id>/sent', methods=['POST'])
@auth_required
@validate_json(ReminderMarkSentRequest)
@async_endpoint
async def mark_reminder_sent(validated_data: ReminderMarkSentRequest, reminder_id: int):
    """
    Mark reminder as sent (for reminder processor).

    Request JSON:
    {
        "schedule_next": true  // optional, for recurring reminders
    }
    """
    try:
        next_reminder = await reminder_service.mark_reminder_sent(
            reminder_id, validated_data.schedule_next
        )

        result = {"message": "Reminder marked as sent"}
        if next_reminder:
            result['next_reminder'] = next_reminder

        return success_response(result)

    except Exception as e:
        logger.error(f"Failed to mark reminder sent: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/reminders/<int:community_id>/user/<int:user_id>', methods=['GET'])
@validate_query(UserRemindersParams)
@async_endpoint
async def get_user_reminders(query_params: UserRemindersParams, community_id: int, user_id: int):
    """
    Get user's reminders.

    Query params:
    - include_sent: Include sent reminders (default false)
    """
    try:
        reminders = await reminder_service.get_user_reminders(
            community_id, user_id, query_params.include_sent
        )
        return success_response({'reminders': reminders, 'count': len(reminders)})

    except Exception as e:
        logger.error(f"Failed to get user reminders: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/reminders/<int:community_id>/<int:reminder_id>', methods=['DELETE'])
@validate_json(ReminderDeleteRequest)
@async_endpoint
async def cancel_reminder(validated_data: ReminderDeleteRequest, community_id: int, reminder_id: int):
    """Cancel a reminder (must be owner)."""
    try:
        success = await reminder_service.cancel_reminder(
            community_id, reminder_id, validated_data.user_id
        )

        if success:
            return success_response({"message": "Reminder cancelled"})
        return error_response("Unauthorized or not found", status_code=403)

    except Exception as e:
        logger.error(f"Failed to cancel reminder: {e}")
        return error_response(str(e), status_code=500)


@api_bp.route('/reminders/<int:community_id>/stats', methods=['GET'])
@async_endpoint
async def get_reminder_stats(community_id: int):
    """Get reminder statistics."""
    try:
        stats = await reminder_service.get_stats(community_id)
        return success_response(stats)

    except Exception as e:
        logger.error(f"Failed to get stats: {e}")
        return error_response(str(e), status_code=500)


app.register_blueprint(api_bp)


if __name__ == '__main__':
    import hypercorn.asyncio
    from hypercorn.config import Config as HyperConfig

    config = HyperConfig()
    config.bind = [f"0.0.0.0:{Config.MODULE_PORT}"]
    asyncio.run(hypercorn.asyncio.serve(app, config))
