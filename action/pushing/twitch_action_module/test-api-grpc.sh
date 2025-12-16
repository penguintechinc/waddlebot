#!/bin/bash
# =============================================================================
# WaddleBot Twitch Action Module - gRPC API Tests
# Tests the gRPC interface for Twitch action functionality
# =============================================================================

set -e

# Configuration
GRPC_HOST="${GRPC_HOST:-localhost:50053}"
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

    print_test "Describe TwitchActionService"
    if grpcurl -plaintext "$GRPC_HOST" describe twitch_action.TwitchActionService 2>/dev/null; then
        print_pass "Service description retrieved"
    else
        print_skip "Service description not available (proto reflection may be disabled)"
    fi
}

# Test ExecuteAction RPC
test_execute_action() {
    print_header "ExecuteAction RPC Tests"

    print_test "ExecuteAction with valid request (mock)"
    local request='{"action_type":"send_message","channel":"testchannel","message":"Test message from gRPC","auth_token":"test-token"}'

    if [ "$VERBOSE" = "true" ]; then
        echo "Request: $request"
    fi

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" twitch_action.TwitchActionService/ExecuteAction 2>&1 || true)

    if echo "$response" | grep -q '"success"'; then
        print_pass "ExecuteAction responded"
        [ "$VERBOSE" = "true" ] && echo "Response: $response"
    elif echo "$response" | grep -q "UNAUTHENTICATED\|Authentication"; then
        print_pass "ExecuteAction rejected invalid token (expected behavior)"
    else
        print_fail "ExecuteAction failed unexpectedly: $response"
    fi
}

# Test BatchExecuteActions RPC
test_batch_execute_actions() {
    print_header "BatchExecuteActions RPC Tests"

    print_test "BatchExecuteActions with valid request (mock)"
    local request='{"actions":[{"action_type":"send_message","channel":"testchannel","message":"Message 1"},{"action_type":"send_message","channel":"testchannel","message":"Message 2"}],"auth_token":"test-token"}'

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" twitch_action.TwitchActionService/BatchExecuteActions 2>&1 || true)

    if echo "$response" | grep -q '"success"\|UNAUTHENTICATED\|Authentication'; then
        print_pass "BatchExecuteActions handled request"
    else
        print_fail "BatchExecuteActions failed: $response"
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
    echo -e "${BLUE}WaddleBot Twitch Action Module - gRPC API Tests${NC}"
    echo "Host: $GRPC_HOST"
    echo "Verbose: $VERBOSE"

    check_dependencies
    test_connectivity
    test_execute_action
    test_batch_execute_actions
    print_summary
}

main "$@"
