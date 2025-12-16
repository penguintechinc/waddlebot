#!/bin/bash
# =============================================================================
# WaddleBot YouTube Action Module - gRPC API Tests
# Tests the gRPC interface for YouTube action functionality
# =============================================================================

set -e

# Configuration
GRPC_HOST="${GRPC_HOST:-localhost:50054}"
PROTO_PATH="${PROTO_PATH:-./proto}"
VERBOSE="${VERBOSE:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Helper functions
print_header() {
    echo -e "\n${BLUE}======================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}======================================${NC}"
}

print_test() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -e "\n${YELLOW}[$TESTS_RUN] Testing: $1${NC}"
}

print_pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}✓ PASS: $1${NC}"
}

print_fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "${RED}✗ FAIL: $1${NC}"
}

print_skip() {
    TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    echo -e "${YELLOW}⊘ SKIP: $1${NC}"
}

# Check dependencies
check_dependencies() {
    print_header "Checking Dependencies"

    if ! command -v grpcurl &> /dev/null; then
        echo -e "${RED}grpcurl is required but not installed.${NC}"
        echo "Install with: go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest"
        echo "Or: brew install grpcurl"
        exit 1
    fi
    print_pass "grpcurl is installed"
}

# Test gRPC connectivity
test_connectivity() {
    print_header "gRPC Connectivity Tests"

    print_test "List available services"
    if grpcurl -plaintext "$GRPC_HOST" list 2>/dev/null; then
        print_pass "Services listed successfully"
    else
        print_fail "Could not list services - server may be down"
        return 1
    fi

    print_test "Describe YouTubeAction service"
    if grpcurl -plaintext "$GRPC_HOST" describe youtube_action.YouTubeAction 2>/dev/null; then
        print_pass "Service description retrieved"
    else
        print_skip "Service description not available (proto reflection may be disabled)"
    fi
}

# Test SendLiveChatMessage RPC
test_send_live_chat_message() {
    print_header "SendLiveChatMessage RPC Tests"

    print_test "SendLiveChatMessage with valid request (mock)"
    local request='{"broadcast_id":"livestream123","message":"Test message from gRPC","auth_token":"test-token"}'

    if [ "$VERBOSE" = "true" ]; then
        echo "Request: $request"
    fi

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" youtube_action.YouTubeAction/SendLiveChatMessage 2>&1 || true)

    if echo "$response" | grep -q '"success"'; then
        print_pass "SendLiveChatMessage responded"
        [ "$VERBOSE" = "true" ] && echo "Response: $response"
    elif echo "$response" | grep -q "UNAUTHENTICATED\|Authentication"; then
        print_pass "SendLiveChatMessage rejected invalid token (expected behavior)"
    else
        print_fail "SendLiveChatMessage failed unexpectedly: $response"
    fi
}

# Test UpdateVideoTitle RPC
test_update_video_title() {
    print_header "UpdateVideoTitle RPC Tests"

    print_test "UpdateVideoTitle with valid request (mock)"
    local request='{"video_id":"dQw4w9WgXcQ","new_title":"Updated Video Title","auth_token":"test-token"}'

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" youtube_action.YouTubeAction/UpdateVideoTitle 2>&1 || true)

    if echo "$response" | grep -q '"success"\|UNAUTHENTICATED\|Authentication'; then
        print_pass "UpdateVideoTitle handled request"
    else
        print_fail "UpdateVideoTitle failed: $response"
    fi
}

# Print summary
print_summary() {
    print_header "Test Summary"
    echo -e "Tests Run:     $TESTS_RUN"
    echo -e "${GREEN}Tests Passed:  $TESTS_PASSED${NC}"
    echo -e "${RED}Tests Failed:  $TESTS_FAILED${NC}"
    echo -e "${YELLOW}Tests Skipped: $TESTS_SKIPPED${NC}"

    if [ $TESTS_FAILED -gt 0 ]; then
        echo -e "\n${RED}Some tests failed!${NC}"
        exit 1
    else
        echo -e "\n${GREEN}All tests passed!${NC}"
        exit 0
    fi
}

# Main
main() {
    echo -e "${BLUE}WaddleBot YouTube Action Module - gRPC API Tests${NC}"
    echo "Host: $GRPC_HOST"
    echo "Verbose: $VERBOSE"

    check_dependencies
    test_connectivity
    test_send_live_chat_message
    test_update_video_title
    print_summary
}

main "$@"
