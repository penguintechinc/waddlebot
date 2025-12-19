#!/usr/bin/env python3
"""
Test script to verify validation models work correctly.

Tests the Pydantic validation models for the Calendar Module to ensure:
1. Valid data is accepted
2. Invalid data is rejected with proper error messages
3. Edge cases are handled correctly
4. The critical int() conversion bug is fixed
"""

import sys
from datetime import datetime, timedelta
from pydantic.v1 import ValidationError

# Import validation models
from validation_models import (
    EventCreateRequest,
    EventSearchParams,
    EventUpdateRequest,
    EventApprovalRequest,
    RSVPRequest,
    EventFullTextSearchParams,
    UpcomingEventsParams,
    CategoryCreateRequest,
    ContextSwitchRequest
)


def test_event_create_request():
    """Test EventCreateRequest validation."""
    print("\n=== Testing EventCreateRequest ===")

    # Valid data
    valid_data = {
        'community_id': 1,
        'title': 'Test Event',
        'description': 'Test description',
        'event_date': datetime.now() + timedelta(days=1),
        'platform': 'twitch',
        'created_by_username': 'testuser'
    }
    try:
        event = EventCreateRequest(**valid_data)
        print("✓ Valid data accepted")
    except ValidationError as e:
        print(f"✗ Valid data rejected: {e}")
        return False

    # Invalid community_id (negative)
    try:
        invalid_data = valid_data.copy()
        invalid_data['community_id'] = -1
        event = EventCreateRequest(**invalid_data)
        print("✗ Negative community_id accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Negative community_id rejected")

    # Invalid title (too short)
    try:
        invalid_data = valid_data.copy()
        invalid_data['title'] = 'AB'
        event = EventCreateRequest(**invalid_data)
        print("✗ Short title accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Short title rejected")

    # Invalid platform
    try:
        invalid_data = valid_data.copy()
        invalid_data['platform'] = 'invalid_platform'
        event = EventCreateRequest(**invalid_data)
        print("✗ Invalid platform accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid platform rejected")

    # Invalid end_date (before event_date)
    try:
        invalid_data = valid_data.copy()
        invalid_data['end_date'] = datetime.now() - timedelta(days=1)
        event = EventCreateRequest(**invalid_data)
        print("✗ Invalid end_date accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid end_date rejected")

    print("✓ EventCreateRequest tests passed")
    return True


def test_event_search_params():
    """Test EventSearchParams validation - CRITICAL FIX TEST."""
    print("\n=== Testing EventSearchParams (CRITICAL FIX) ===")

    # Valid data
    valid_data = {
        'limit': 50,
        'offset': 0,
        'platform': 'discord'
    }
    try:
        params = EventSearchParams(**valid_data)
        print("✓ Valid params accepted")
    except ValidationError as e:
        print(f"✗ Valid params rejected: {e}")
        return False

    # CRITICAL TEST: Invalid limit (string instead of int)
    # This was causing 500 errors with unsafe int() conversion
    try:
        invalid_data = {'limit': 'not_a_number', 'offset': 0}
        params = EventSearchParams(**invalid_data)
        print("✗ String limit accepted (CRITICAL BUG NOT FIXED)")
        return False
    except ValidationError:
        print("✓ String limit rejected (CRITICAL BUG FIXED)")

    # CRITICAL TEST: Invalid offset (string instead of int)
    try:
        invalid_data = {'limit': 50, 'offset': 'invalid'}
        params = EventSearchParams(**invalid_data)
        print("✗ String offset accepted (CRITICAL BUG NOT FIXED)")
        return False
    except ValidationError:
        print("✓ String offset rejected (CRITICAL BUG FIXED)")

    # Invalid limit (too high)
    try:
        invalid_data = {'limit': 200, 'offset': 0}
        params = EventSearchParams(**invalid_data)
        print("✗ Limit > 100 accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Limit > 100 rejected")

    # Invalid offset (negative)
    try:
        invalid_data = {'limit': 50, 'offset': -10}
        params = EventSearchParams(**invalid_data)
        print("✗ Negative offset accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Negative offset rejected")

    # Invalid platform
    try:
        invalid_data = {'limit': 50, 'offset': 0, 'platform': 'youtube'}
        params = EventSearchParams(**invalid_data)
        print("✗ Invalid platform accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid platform rejected")

    # Invalid date range
    try:
        invalid_data = {
            'limit': 50,
            'offset': 0,
            'date_from': datetime.now(),
            'date_to': datetime.now() - timedelta(days=1)
        }
        params = EventSearchParams(**invalid_data)
        print("✗ Invalid date range accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid date range rejected")

    print("✓ EventSearchParams tests passed (CRITICAL BUG FIXED)")
    return True


def test_event_update_request():
    """Test EventUpdateRequest validation."""
    print("\n=== Testing EventUpdateRequest ===")

    # Valid data (partial update)
    valid_data = {
        'title': 'Updated Title',
        'description': 'Updated description'
    }
    try:
        update = EventUpdateRequest(**valid_data)
        print("✓ Valid partial update accepted")
    except ValidationError as e:
        print(f"✗ Valid partial update rejected: {e}")
        return False

    # Empty object (all fields optional)
    try:
        update = EventUpdateRequest()
        print("✓ Empty update accepted")
    except ValidationError as e:
        print(f"✗ Empty update rejected: {e}")
        return False

    # Invalid status
    try:
        invalid_data = {'status': 'invalid_status'}
        update = EventUpdateRequest(**invalid_data)
        print("✗ Invalid status accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid status rejected")

    print("✓ EventUpdateRequest tests passed")
    return True


def test_event_approval_request():
    """Test EventApprovalRequest validation."""
    print("\n=== Testing EventApprovalRequest ===")

    # Valid approval
    try:
        approval = EventApprovalRequest(status='approved', notes='Looks good')
        print("✓ Valid approval accepted")
    except ValidationError as e:
        print(f"✗ Valid approval rejected: {e}")
        return False

    # Valid rejection
    try:
        rejection = EventApprovalRequest(status='rejected', notes='Invalid event')
        print("✓ Valid rejection accepted")
    except ValidationError as e:
        print(f"✗ Valid rejection rejected: {e}")
        return False

    # Invalid status
    try:
        approval = EventApprovalRequest(status='pending')
        print("✗ Invalid status 'pending' accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid status 'pending' rejected")

    print("✓ EventApprovalRequest tests passed")
    return True


def test_rsvp_request():
    """Test RSVPRequest validation."""
    print("\n=== Testing RSVPRequest ===")

    # Valid RSVP
    try:
        rsvp = RSVPRequest(status='yes', guest_count=2, note='Looking forward to it')
        print("✓ Valid RSVP accepted")
    except ValidationError as e:
        print(f"✗ Valid RSVP rejected: {e}")
        return False

    # Invalid status
    try:
        rsvp = RSVPRequest(status='confirmed')
        print("✗ Invalid status accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid status rejected")

    # Invalid guest_count (negative)
    try:
        rsvp = RSVPRequest(status='yes', guest_count=-1)
        print("✗ Negative guest_count accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Negative guest_count rejected")

    # Invalid guest_count (too high)
    try:
        rsvp = RSVPRequest(status='yes', guest_count=20)
        print("✗ Guest_count > 10 accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Guest_count > 10 rejected")

    print("✓ RSVPRequest tests passed")
    return True


def test_full_text_search_params():
    """Test EventFullTextSearchParams validation."""
    print("\n=== Testing EventFullTextSearchParams ===")

    # Valid search
    try:
        search = EventFullTextSearchParams(q='gaming event')
        print("✓ Valid search accepted")
    except ValidationError as e:
        print(f"✗ Valid search rejected: {e}")
        return False

    # Empty query
    try:
        search = EventFullTextSearchParams(q='')
        print("✗ Empty query accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Empty query rejected")

    # Whitespace-only query
    try:
        search = EventFullTextSearchParams(q='   ')
        print("✗ Whitespace-only query accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Whitespace-only query rejected")

    print("✓ EventFullTextSearchParams tests passed")
    return True


def test_upcoming_events_params():
    """Test UpcomingEventsParams validation."""
    print("\n=== Testing UpcomingEventsParams ===")

    # Valid params
    try:
        params = UpcomingEventsParams(limit=20)
        print("✓ Valid params accepted")
    except ValidationError as e:
        print(f"✗ Valid params rejected: {e}")
        return False

    # Invalid limit (zero)
    try:
        params = UpcomingEventsParams(limit=0)
        print("✗ Zero limit accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Zero limit rejected")

    # Invalid limit (too high)
    try:
        params = UpcomingEventsParams(limit=150)
        print("✗ Limit > 100 accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Limit > 100 rejected")

    print("✓ UpcomingEventsParams tests passed")
    return True


def test_category_create_request():
    """Test CategoryCreateRequest validation."""
    print("\n=== Testing CategoryCreateRequest ===")

    # Valid category
    try:
        category = CategoryCreateRequest(name='Gaming', color='#FF5733', display_order=10)
        print("✓ Valid category accepted")
    except ValidationError as e:
        print(f"✗ Valid category rejected: {e}")
        return False

    # Invalid name (too short)
    try:
        category = CategoryCreateRequest(name='A')
        print("✗ Short name accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Short name rejected")

    # Invalid color format
    try:
        category = CategoryCreateRequest(name='Gaming', color='red')
        print("✗ Invalid color format accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Invalid color format rejected")

    # Invalid display_order (negative)
    try:
        category = CategoryCreateRequest(name='Gaming', display_order=-1)
        print("✗ Negative display_order accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Negative display_order rejected")

    print("✓ CategoryCreateRequest tests passed")
    return True


def test_context_switch_request():
    """Test ContextSwitchRequest validation."""
    print("\n=== Testing ContextSwitchRequest ===")

    # Valid switch
    try:
        switch = ContextSwitchRequest(community_name='My Community')
        print("✓ Valid switch accepted")
    except ValidationError as e:
        print(f"✗ Valid switch rejected: {e}")
        return False

    # Empty community_name
    try:
        switch = ContextSwitchRequest(community_name='')
        print("✗ Empty community_name accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Empty community_name rejected")

    # Whitespace-only community_name
    try:
        switch = ContextSwitchRequest(community_name='   ')
        print("✗ Whitespace-only community_name accepted (should be rejected)")
        return False
    except ValidationError:
        print("✓ Whitespace-only community_name rejected")

    print("✓ ContextSwitchRequest tests passed")
    return True


def main():
    """Run all validation tests."""
    print("=" * 60)
    print("Calendar Module Validation Tests")
    print("=" * 60)

    tests = [
        test_event_create_request,
        test_event_search_params,
        test_event_update_request,
        test_event_approval_request,
        test_rsvp_request,
        test_full_text_search_params,
        test_upcoming_events_params,
        test_category_create_request,
        test_context_switch_request
    ]

    results = []
    for test in tests:
        try:
            result = test()
            results.append(result)
        except Exception as e:
            print(f"✗ Test failed with exception: {e}")
            results.append(False)

    print("\n" + "=" * 60)
    print(f"Test Results: {sum(results)}/{len(results)} passed")
    print("=" * 60)

    if all(results):
        print("\n✓ ALL TESTS PASSED")
        print("✓ CRITICAL BUG FIXED: int() conversion errors prevented")
        return 0
    else:
        print("\n✗ SOME TESTS FAILED")
        return 1


if __name__ == '__main__':
    sys.exit(main())
