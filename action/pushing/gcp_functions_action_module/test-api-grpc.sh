#!/bin/bash
# =============================================================================
# WaddleBot GCP Functions Action Module - gRPC API Tests
# Tests the gRPC interface for GCP Functions action functionality
# =============================================================================

set -e

# Configuration
GRPC_HOST="${GRPC_HOST:-localhost:50061}"
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

    print_test "Describe GCPFunctionsActionService"
    if grpcurl -plaintext "$GRPC_HOST" describe gcp_functions_action.GCPFunctionsActionService 2>/dev/null; then
        print_pass "Service description retrieved"
    else
        print_skip "Service description not available (proto reflection may be disabled)"
    fi
}

# Test InvokeFunction RPC
test_invoke_function() {
    print_header "InvokeFunction RPC Tests"

    print_test "InvokeFunction with valid request (mock)"
    local request='{"project_id":"test-project","region":"us-central1","function_name":"test-function","payload":"{\"key\":\"value\"}"}'

    if [ "$VERBOSE" = "true" ]; then
        echo "Request: $request"
    fi

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" gcp_functions_action.GCPFunctionsActionService/InvokeFunction 2>&1 || true)

    if echo "$response" | grep -q '"success"'; then
        print_pass "InvokeFunction responded"
        [ "$VERBOSE" = "true" ] && echo "Response: $response"
    elif echo "$response" | grep -q "UNAUTHENTICATED\|Authentication"; then
        print_pass "InvokeFunction rejected invalid credentials (expected behavior)"
    else
        print_fail "InvokeFunction failed unexpectedly: $response"
    fi
}

# Test ListFunctions RPC
test_list_functions() {
    print_header "ListFunctions RPC Tests"

    print_test "ListFunctions with valid request (mock)"
    local request='{"project_id":"test-project","region":"us-central1"}'

    local response=$(grpcurl -plaintext -d "$request" "$GRPC_HOST" gcp_functions_action.GCPFunctionsActionService/ListFunctions 2>&1 || true)

    if echo "$response" | grep -q '"success"\|UNAUTHENTICATED\|Authentication'; then
        print_pass "ListFunctions handled request"
    else
        print_fail "ListFunctions failed: $response"
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
    echo -e "${BLUE}WaddleBot GCP Functions Action Module - gRPC API Tests${NC}"
    echo "Host: $GRPC_HOST"
    echo "Verbose: $VERBOSE"

    check_dependencies
    test_connectivity
    test_invoke_function
    test_list_functions
    print_summary
}

main "$@"
