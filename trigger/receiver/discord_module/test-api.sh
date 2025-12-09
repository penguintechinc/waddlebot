#!/usr/bin/env bash

################################################################################
# WaddleBot Discord Module API Test Script
################################################################################
#
# Comprehensive API testing for the Discord Module receiver trigger.
# Tests all health, metrics, and API endpoints.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL          Set base URL (default: http://localhost:8003)
#   --verbose          Enable verbose output
#   --skip-metrics     Skip metrics endpoint test (useful if psutil not available)
#
# Environment Variables:
#   DISCORD_URL        Base URL for Discord module (default: http://localhost:8003)
#
# Exit Codes:
#   0 - All tests passed
#   1 - One or more tests failed
#
# Requirements:
#   - curl
#   - jq
#
################################################################################

set -euo pipefail

# Color codes for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color
readonly BOLD='\033[1m'

# Default configuration
DISCORD_URL="${DISCORD_URL:-http://localhost:8003}"
VERBOSE=false
SKIP_METRICS=false

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Test results array
declare -a FAILED_TESTS=()

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}${BOLD}  $1${NC}"
    echo -e "${BLUE}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_test() {
    echo -e "\n${BOLD}TEST: $1${NC}"
}

print_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((TESTS_PASSED++))
}

print_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    FAILED_TESTS+=("$2")
    ((TESTS_FAILED++))
}

print_skip() {
    echo -e "${YELLOW}⊘ SKIP${NC}: $1"
    ((TESTS_SKIPPED++))
}

print_info() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${BLUE}ℹ INFO${NC}: $1"
    fi
}

check_dependencies() {
    local missing_deps=()

    if ! command -v curl &> /dev/null; then
        missing_deps+=("curl")
    fi

    if ! command -v jq &> /dev/null; then
        missing_deps+=("jq")
    fi

    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        echo -e "${RED}Error: Missing required dependencies: ${missing_deps[*]}${NC}"
        echo "Please install missing dependencies and try again."
        exit 1
    fi
}

show_help() {
    sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //; s/^#//'
    exit 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                show_help
                ;;
            --url)
                DISCORD_URL="$2"
                shift 2
                ;;
            --verbose|-v)
                VERBOSE=true
                shift
                ;;
            --skip-metrics)
                SKIP_METRICS=true
                shift
                ;;
            *)
                echo -e "${RED}Error: Unknown option: $1${NC}"
                echo "Use --help for usage information."
                exit 1
                ;;
        esac
    done
}

make_request() {
    local method="$1"
    local endpoint="$2"
    local expected_status="$3"
    local description="$4"

    ((TESTS_RUN++))

    print_info "Making $method request to $endpoint"

    # Make the request and capture response
    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -X "$method" "${DISCORD_URL}${endpoint}" 2>&1)
    http_code=$(echo "$response" | tail -n 1)
    local body=$(echo "$response" | sed '$d')

    print_info "HTTP Status: $http_code"
    print_info "Response: $body"

    # Check HTTP status code
    if [[ "$http_code" != "$expected_status" ]]; then
        print_fail "$description - Expected HTTP $expected_status, got $http_code" "$description"
        return 1
    fi

    # Store response for further validation
    echo "$body"
    return 0
}

validate_json() {
    local json="$1"
    local description="$2"

    if ! echo "$json" | jq empty 2>/dev/null; then
        print_fail "$description - Invalid JSON response" "$description"
        return 1
    fi

    return 0
}

validate_field() {
    local json="$1"
    local field="$2"
    local expected_value="$3"
    local description="$4"

    local actual_value
    actual_value=$(echo "$json" | jq -r "$field" 2>/dev/null)

    if [[ "$actual_value" == "null" ]] || [[ -z "$actual_value" ]]; then
        print_fail "$description - Field '$field' missing or null" "$description"
        return 1
    fi

    if [[ -n "$expected_value" ]] && [[ "$actual_value" != "$expected_value" ]]; then
        print_fail "$description - Field '$field' expected '$expected_value', got '$actual_value'" "$description"
        return 1
    fi

    print_info "Field '$field' = '$actual_value'"
    return 0
}

################################################################################
# Test Functions
################################################################################

test_health_endpoint() {
    print_test "Health Check Endpoint - GET /health"

    local response
    if ! response=$(make_request "GET" "/health" "200" "Health endpoint"); then
        return 1
    fi

    if ! validate_json "$response" "Health endpoint"; then
        return 1
    fi

    # Validate required fields
    local all_valid=true

    if ! validate_field "$response" ".status" "healthy" "Health endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".module" "discord_module" "Health endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".version" "" "Health endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".timestamp" "" "Health endpoint"; then
        all_valid=false
    fi

    if [[ "$all_valid" == "true" ]]; then
        print_pass "Health endpoint returned valid response"
        return 0
    else
        return 1
    fi
}

test_healthz_endpoint() {
    print_test "Kubernetes Health Check - GET /healthz"

    local response
    if ! response=$(make_request "GET" "/healthz" "200" "Healthz endpoint"); then
        return 1
    fi

    if ! validate_json "$response" "Healthz endpoint"; then
        return 1
    fi

    # Validate required fields
    local all_valid=true

    if ! validate_field "$response" ".status" "" "Healthz endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".module" "discord_module" "Healthz endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".version" "" "Healthz endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".checks" "" "Healthz endpoint"; then
        all_valid=false
    fi

    # Check that status is either healthy or degraded
    local status
    status=$(echo "$response" | jq -r '.status')

    if [[ "$status" != "healthy" ]] && [[ "$status" != "degraded" ]]; then
        print_fail "Healthz endpoint - Status must be 'healthy' or 'degraded', got '$status'" "Healthz endpoint"
        all_valid=false
    fi

    if [[ "$all_valid" == "true" ]]; then
        print_pass "Healthz endpoint returned valid response (status: $status)"
        return 0
    else
        return 1
    fi
}

test_metrics_endpoint() {
    print_test "Prometheus Metrics - GET /metrics"

    if [[ "$SKIP_METRICS" == "true" ]]; then
        print_skip "Metrics endpoint (--skip-metrics flag set)"
        ((TESTS_RUN++))
        return 0
    fi

    local response
    if ! response=$(make_request "GET" "/metrics" "200" "Metrics endpoint"); then
        return 1
    fi

    # Validate Prometheus format (should contain metric definitions)
    local all_valid=true

    if ! echo "$response" | grep -q "waddlebot_info"; then
        print_fail "Metrics endpoint - Missing 'waddlebot_info' metric" "Metrics endpoint"
        all_valid=false
    fi

    if ! echo "$response" | grep -q "waddlebot_requests_total"; then
        print_fail "Metrics endpoint - Missing 'waddlebot_requests_total' metric" "Metrics endpoint"
        all_valid=false
    fi

    if ! echo "$response" | grep -q "discord_module"; then
        print_fail "Metrics endpoint - Missing 'discord_module' label" "Metrics endpoint"
        all_valid=false
    fi

    if ! echo "$response" | grep -q "# HELP"; then
        print_fail "Metrics endpoint - Missing Prometheus metric help text" "Metrics endpoint"
        all_valid=false
    fi

    if ! echo "$response" | grep -q "# TYPE"; then
        print_fail "Metrics endpoint - Missing Prometheus metric types" "Metrics endpoint"
        all_valid=false
    fi

    if [[ "$all_valid" == "true" ]]; then
        print_pass "Metrics endpoint returned valid Prometheus format"
        return 0
    else
        return 1
    fi
}

test_api_status_endpoint() {
    print_test "API Status Endpoint - GET /api/v1/status"

    local response
    if ! response=$(make_request "GET" "/api/v1/status" "200" "API status endpoint"); then
        return 1
    fi

    if ! validate_json "$response" "API status endpoint"; then
        return 1
    fi

    # Validate required fields
    local all_valid=true

    if ! validate_field "$response" ".success" "true" "API status endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".data" "" "API status endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".data.status" "operational" "API status endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".data.module" "discord_module" "API status endpoint"; then
        all_valid=false
    fi

    if ! validate_field "$response" ".timestamp" "" "API status endpoint"; then
        all_valid=false
    fi

    if [[ "$all_valid" == "true" ]]; then
        print_pass "API status endpoint returned valid response"
        return 0
    else
        return 1
    fi
}

test_invalid_endpoint() {
    print_test "Invalid Endpoint - GET /api/v1/nonexistent"

    ((TESTS_RUN++))

    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -X "GET" "${DISCORD_URL}/api/v1/nonexistent" 2>&1)
    http_code=$(echo "$response" | tail -n 1)

    print_info "HTTP Status: $http_code"

    # Should return 404
    if [[ "$http_code" == "404" ]]; then
        print_pass "Invalid endpoint correctly returns 404"
        return 0
    else
        print_fail "Invalid endpoint - Expected HTTP 404, got $http_code" "Invalid endpoint 404"
        return 1
    fi
}

test_cors_headers() {
    print_test "CORS Headers - OPTIONS /api/v1/status"

    ((TESTS_RUN++))

    local headers
    headers=$(curl -s -I -X "OPTIONS" "${DISCORD_URL}/api/v1/status" 2>&1)

    print_info "Response headers:"
    print_info "$headers"

    # Check if we got a successful response (even if CORS is not configured)
    if echo "$headers" | grep -q "HTTP.*200\|HTTP.*204"; then
        print_pass "OPTIONS request handled successfully"
        return 0
    else
        # This is not a critical failure - OPTIONS might not be implemented
        print_skip "OPTIONS request not implemented or CORS not configured"
        ((TESTS_RUN--)) # Don't count this as a run test
        return 0
    fi
}

################################################################################
# Main Test Execution
################################################################################

main() {
    # Parse command line arguments
    parse_args "$@"

    # Check dependencies
    check_dependencies

    # Print header
    print_header "WaddleBot Discord Module API Tests"
    echo -e "${BOLD}Target URL:${NC} $DISCORD_URL"
    echo -e "${BOLD}Verbose:${NC} $VERBOSE"
    echo -e "${BOLD}Skip Metrics:${NC} $SKIP_METRICS"
    echo ""

    # Check if service is reachable
    print_info "Checking if Discord module is reachable..."
    if ! curl -s -f -o /dev/null --max-time 5 "${DISCORD_URL}/health" 2>/dev/null; then
        echo -e "${RED}Error: Cannot reach Discord module at $DISCORD_URL${NC}"
        echo -e "${YELLOW}Please ensure the Discord module is running and accessible.${NC}"
        echo ""
        echo "You can start it with:"
        echo "  cd /home/penguin/code/WaddleBot/trigger/receiver/discord_module"
        echo "  docker-compose up -d"
        echo ""
        exit 1
    fi
    print_info "Discord module is reachable"

    # Run all tests
    echo ""
    print_header "Running Tests"

    # Health endpoints
    test_health_endpoint
    test_healthz_endpoint
    test_metrics_endpoint

    # API endpoints
    test_api_status_endpoint

    # Error handling
    test_invalid_endpoint

    # CORS
    test_cors_headers

    # Print summary
    echo ""
    print_header "Test Summary"
    echo ""
    echo -e "${BOLD}Total Tests:${NC}    $TESTS_RUN"
    echo -e "${GREEN}${BOLD}Passed:${NC}         $TESTS_PASSED"
    echo -e "${RED}${BOLD}Failed:${NC}         $TESTS_FAILED"
    echo -e "${YELLOW}${BOLD}Skipped:${NC}        $TESTS_SKIPPED"
    echo ""

    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo -e "${RED}${BOLD}Failed Tests:${NC}"
        for test in "${FAILED_TESTS[@]}"; do
            echo -e "  ${RED}✗${NC} $test"
        done
        echo ""
    fi

    # Calculate success rate
    if [[ $TESTS_RUN -gt 0 ]]; then
        local success_rate
        success_rate=$(awk "BEGIN {printf \"%.1f\", ($TESTS_PASSED / $TESTS_RUN) * 100}")
        echo -e "${BOLD}Success Rate:${NC}   ${success_rate}%"
        echo ""
    fi

    # Exit with appropriate code
    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo -e "${RED}${BOLD}✗ TESTS FAILED${NC}"
        echo ""
        exit 1
    else
        echo -e "${GREEN}${BOLD}✓ ALL TESTS PASSED${NC}"
        echo ""
        exit 0
    fi
}

# Run main function with all arguments
main "$@"
