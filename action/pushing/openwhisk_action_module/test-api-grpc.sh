#!/bin/bash
# =============================================================================
# WaddleBot OpenWhisk Action Module - gRPC API Tests
# Tests the gRPC interface for OpenWhisk action functionality
# =============================================================================

set -e

# Configuration
GRPC_HOST="${GRPC_HOST:-localhost:50062}"
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

    print_test "Describe OpenWhiskActionService"
    if grpcurl -plaintext "$GRPC_HOST" describe openwhisk_action.OpenWhiskActionService 2>/dev/null; then
        print_pass "Service description retrieved"
    else
        print_skip "Service description not available (proto reflection may be disabled)"
    fi
}

# Test InvokeAction RPC
test_invoke_action() {
    print_header "InvokeAction RPC Tests"

    print_test "InvokeAction with valid request (mock)"
    local request='{"action_name":"test-action","namespace":"default","payload":"{\"key\":\"value\"}","blocking":true}'

    if [ "$VERBOSE" = "true" ]; then
        echo "Request: $request"
    fi

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" openwhisk_action.OpenWhiskActionService/InvokeAction 2>&1 || true)

    if echo "$response" | grep -q '"success"'; then
        print_pass "InvokeAction responded"
        [ "$VERBOSE" = "true" ] && echo "Response: $response"
    elif echo "$response" | grep -q "UNAUTHENTICATED\|Authentication"; then
        print_pass "InvokeAction rejected invalid credentials (expected behavior)"
    else
        print_fail "InvokeAction failed unexpectedly: $response"
    fi
}

# Test ListActions RPC
test_list_actions() {
    print_header "ListActions RPC Tests"

    print_test "ListActions with valid request (mock)"
    local request='{"namespace":"default"}'

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" openwhisk_action.OpenWhiskActionService/ListActions 2>&1 || true)

    if echo "$response" | grep -q '"success"\|UNAUTHENTICATED\|Authentication'; then
        print_pass "ListActions handled request"
    else
        print_fail "ListActions failed: $response"
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
    echo -e "${BLUE}WaddleBot OpenWhisk Action Module - gRPC API Tests${NC}"
    echo "Host: $GRPC_HOST"
    echo "Verbose: $VERBOSE"

    check_dependencies
    test_connectivity
    test_invoke_action
    test_list_actions
    print_summary
}

main "$@"
