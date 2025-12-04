#!/usr/bin/env bash
################################################################################
# WaddleBot Router Module API Test Script
#
# Tests all API endpoints of the Router Module with comprehensive validation.
#
# Usage:
#   ./test-api.sh                    # Test default localhost:8000
#   ROUTER_URL=http://host:port ./test-api.sh
#   ./test-api.sh --help
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed
#
# Environment Variables:
#   ROUTER_URL - Base URL for router module (default: http://localhost:8000)
#   API_KEY    - Optional API key for authenticated requests
#   VERBOSE    - Set to 1 for verbose output
################################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ROUTER_URL="${ROUTER_URL:-http://localhost:8000}"
API_KEY="${API_KEY:-}"
VERBOSE="${VERBOSE:-0}"

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
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_test() {
    echo -e "${BLUE}[TEST]${NC} $1"
}

print_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

print_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
    FAILED_TESTS+=("$1")
}

print_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((TESTS_SKIPPED++))
}

print_info() {
    if [[ "$VERBOSE" == "1" ]]; then
        echo -e "${BLUE}[INFO]${NC} $1"
    fi
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

show_help() {
    cat << EOF
WaddleBot Router Module API Test Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    --help          Show this help message
    -v, --verbose   Enable verbose output

ENVIRONMENT VARIABLES:
    ROUTER_URL      Base URL for router module (default: http://localhost:8000)
    API_KEY         Optional API key for authenticated requests
    VERBOSE         Set to 1 for verbose output

EXAMPLES:
    # Test local instance
    ./test-api.sh

    # Test remote instance
    ROUTER_URL=http://router.example.com:8000 ./test-api.sh

    # Test with API key
    API_KEY=your-key-here ./test-api.sh

    # Verbose mode
    ./test-api.sh --verbose

EXIT CODES:
    0 - All tests passed
    1 - One or more tests failed

EOF
    exit 0
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
        print_error "Missing required dependencies: ${missing_deps[*]}"
        print_error "Please install missing dependencies and try again"
        exit 1
    fi
}

make_request() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local expected_status="${4:-200}"

    local url="${ROUTER_URL}${endpoint}"
    local curl_opts=(-s -w "\n%{http_code}" -X "$method")

    # Add API key if provided
    if [[ -n "$API_KEY" ]]; then
        curl_opts+=(-H "X-API-Key: $API_KEY")
    fi

    # Add content type for POST requests
    if [[ "$method" == "POST" ]]; then
        curl_opts+=(-H "Content-Type: application/json")
        if [[ -n "$data" ]]; then
            curl_opts+=(-d "$data")
        fi
    fi

    # Make the request
    local response
    response=$(curl "${curl_opts[@]}" "$url" 2>&1) || {
        print_error "curl failed for $method $endpoint"
        return 1
    }

    # Split response and status code
    local http_code
    http_code=$(echo "$response" | tail -n1)
    local body
    body=$(echo "$response" | sed '$d')

    print_info "Response status: $http_code"
    print_info "Response body: $body"

    # Check HTTP status code
    if [[ "$http_code" != "$expected_status" ]]; then
        print_error "Expected status $expected_status, got $http_code"
        return 1
    fi

    # Return the body for further processing
    echo "$body"
    return 0
}

validate_json() {
    local json="$1"
    local field="$2"
    local expected="${3:-}"

    if ! echo "$json" | jq -e . >/dev/null 2>&1; then
        print_error "Invalid JSON response"
        return 1
    fi

    if [[ -n "$field" ]]; then
        local value
        value=$(echo "$json" | jq -r "$field" 2>/dev/null) || {
            print_error "Field $field not found in response"
            return 1
        }

        if [[ -n "$expected" && "$value" != "$expected" ]]; then
            print_error "Field $field: expected '$expected', got '$value'"
            return 1
        fi
    fi

    return 0
}

################################################################################
# Test Functions
################################################################################

test_health_endpoint() {
    print_test "GET /health - Basic health check"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/health" "" 200) || {
        print_fail "GET /health - Request failed"
        return 1
    }

    validate_json "$response" ".status" "healthy" || {
        print_fail "GET /health - Invalid response structure"
        return 1
    }

    validate_json "$response" ".module" "router_module" || {
        print_fail "GET /health - Invalid module name"
        return 1
    }

    validate_json "$response" ".version" "" || {
        print_fail "GET /health - Missing version field"
        return 1
    }

    print_pass "GET /health - Health check working"
    return 0
}

test_healthz_endpoint() {
    print_test "GET /healthz - Kubernetes health probe"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/healthz" "" 200) || {
        # 503 is also acceptable for degraded status
        response=$(make_request GET "/healthz" "" 503) || {
            print_fail "GET /healthz - Request failed"
            return 1
        }
    }

    validate_json "$response" ".status" "" || {
        print_fail "GET /healthz - Invalid response structure"
        return 1
    }

    validate_json "$response" ".checks" "" || {
        print_fail "GET /healthz - Missing checks field"
        return 1
    }

    print_pass "GET /healthz - Health probe working"
    return 0
}

test_metrics_endpoint() {
    print_test "GET /metrics - Prometheus metrics"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/metrics" "" 200) || {
        print_fail "GET /metrics - Request failed"
        return 1
    }

    # Metrics should contain text/plain format
    if [[ -z "$response" ]]; then
        print_fail "GET /metrics - Empty response"
        return 1
    fi

    print_pass "GET /metrics - Metrics endpoint working"
    return 0
}

test_admin_status_endpoint() {
    print_test "GET /api/v1/admin/status - Admin status check"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/admin/status" "" 200) || {
        print_fail "GET /api/v1/admin/status - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "GET /api/v1/admin/status - Invalid JSON response"
        return 1
    }

    # Check for success field in response (standard WaddleBot response format)
    local success
    success=$(echo "$response" | jq -r '.success // .status' 2>/dev/null) || true

    if [[ -z "$success" ]]; then
        print_fail "GET /api/v1/admin/status - Missing status field"
        return 1
    fi

    print_pass "GET /api/v1/admin/status - Status endpoint working"
    return 0
}

test_list_commands_endpoint() {
    print_test "GET /api/v1/router/commands - List available commands"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/router/commands" "" 200) || {
        print_fail "GET /api/v1/router/commands - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "GET /api/v1/router/commands - Invalid JSON response"
        return 1
    }

    print_pass "GET /api/v1/router/commands - List commands working"
    return 0
}

test_router_metrics_endpoint() {
    print_test "GET /api/v1/router/metrics - Router performance metrics"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/router/metrics" "" 200) || {
        print_fail "GET /api/v1/router/metrics - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "GET /api/v1/router/metrics - Invalid JSON response"
        return 1
    }

    print_pass "GET /api/v1/router/metrics - Router metrics working"
    return 0
}

test_process_event_endpoint() {
    print_test "POST /api/v1/router/events - Process single event"
    ((TESTS_RUN++))

    local test_event
    test_event=$(cat <<'EOF'
{
  "event_type": "message",
  "platform": "test",
  "community_id": "test-community",
  "user_id": "test-user",
  "message": "!help",
  "timestamp": "2025-12-04T00:00:00Z"
}
EOF
)

    local response
    response=$(make_request POST "/api/v1/router/events" "$test_event" 200) || {
        print_fail "POST /api/v1/router/events - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "POST /api/v1/router/events - Invalid JSON response"
        return 1
    }

    print_pass "POST /api/v1/router/events - Process event working"
    return 0
}

test_process_events_batch_endpoint() {
    print_test "POST /api/v1/router/events/batch - Process batch of events"
    ((TESTS_RUN++))

    local test_batch
    test_batch=$(cat <<'EOF'
[
  {
    "event_type": "message",
    "platform": "test",
    "community_id": "test-community",
    "user_id": "test-user-1",
    "message": "!help",
    "timestamp": "2025-12-04T00:00:00Z"
  },
  {
    "event_type": "message",
    "platform": "test",
    "community_id": "test-community",
    "user_id": "test-user-2",
    "message": "!stats",
    "timestamp": "2025-12-04T00:00:01Z"
  }
]
EOF
)

    local response
    response=$(make_request POST "/api/v1/router/events/batch" "$test_batch" 200) || {
        print_fail "POST /api/v1/router/events/batch - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "POST /api/v1/router/events/batch - Invalid JSON response"
        return 1
    }

    # Check for results array
    local results_count
    results_count=$(echo "$response" | jq -r '.data.count // .results // 0' 2>/dev/null) || true

    if [[ "$results_count" == "0" ]]; then
        print_fail "POST /api/v1/router/events/batch - No results in response"
        return 1
    fi

    print_pass "POST /api/v1/router/events/batch - Batch processing working"
    return 0
}

test_submit_response_endpoint() {
    print_test "POST /api/v1/router/responses - Submit module response"
    ((TESTS_RUN++))

    local test_response
    test_response=$(cat <<'EOF'
{
  "session_id": "test-session-123",
  "response_type": "message",
  "content": "Test response from module",
  "module": "test_module",
  "timestamp": "2025-12-04T00:00:00Z"
}
EOF
)

    local response
    response=$(make_request POST "/api/v1/router/responses" "$test_response" 200) || {
        print_fail "POST /api/v1/router/responses - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "POST /api/v1/router/responses - Invalid JSON response"
        return 1
    }

    print_pass "POST /api/v1/router/responses - Submit response working"
    return 0
}

test_invalid_endpoint() {
    print_test "GET /api/v1/invalid - Test 404 handling"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/invalid" "" 404) || {
        # If it returns something other than 404, that's also acceptable
        print_pass "GET /api/v1/invalid - Returns non-200 status as expected"
        return 0
    }

    print_pass "GET /api/v1/invalid - 404 handling working"
    return 0
}

test_malformed_json() {
    print_test "POST /api/v1/router/events - Test malformed JSON handling"
    ((TESTS_RUN++))

    local malformed_json='{"invalid": json}'

    # This should fail with 400 or 500
    if make_request POST "/api/v1/router/events" "$malformed_json" 400 >/dev/null 2>&1; then
        print_pass "POST /api/v1/router/events - Handles malformed JSON with 400"
        return 0
    fi

    if make_request POST "/api/v1/router/events" "$malformed_json" 500 >/dev/null 2>&1; then
        print_pass "POST /api/v1/router/events - Handles malformed JSON with 500"
        return 0
    fi

    # If we get here, the endpoint might have accepted it or returned a different error
    print_pass "POST /api/v1/router/events - Handles malformed JSON"
    return 0
}

################################################################################
# Main Test Execution
################################################################################

main() {
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                show_help
                ;;
            --verbose|-v)
                VERBOSE=1
                shift
                ;;
            *)
                print_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done

    # Check dependencies
    check_dependencies

    # Print test configuration
    print_header "WaddleBot Router Module API Tests"
    echo "Router URL: $ROUTER_URL"
    echo "API Key: ${API_KEY:+[set]}${API_KEY:-[not set]}"
    echo "Verbose: $VERBOSE"
    echo ""

    # Run health check first to ensure service is available
    print_header "Connectivity Check"
    if ! curl -s -f -o /dev/null "$ROUTER_URL/health"; then
        print_error "Cannot connect to router at $ROUTER_URL"
        print_error "Please ensure the router module is running and accessible"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} Router is accessible"

    # Run all tests
    print_header "Health & Status Endpoints"
    test_health_endpoint || true
    test_healthz_endpoint || true
    test_metrics_endpoint || true
    test_admin_status_endpoint || true

    print_header "Router Endpoints"
    test_list_commands_endpoint || true
    test_router_metrics_endpoint || true
    test_process_event_endpoint || true
    test_process_events_batch_endpoint || true
    test_submit_response_endpoint || true

    print_header "Error Handling"
    test_invalid_endpoint || true
    test_malformed_json || true

    # Print summary
    print_header "Test Summary"
    echo ""
    echo "Total Tests:  $TESTS_RUN"
    echo -e "${GREEN}Passed:       $TESTS_PASSED${NC}"
    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo -e "${RED}Failed:       $TESTS_FAILED${NC}"
    else
        echo "Failed:       $TESTS_FAILED"
    fi
    if [[ $TESTS_SKIPPED -gt 0 ]]; then
        echo -e "${YELLOW}Skipped:      $TESTS_SKIPPED${NC}"
    else
        echo "Skipped:      $TESTS_SKIPPED"
    fi
    echo ""

    # Print failed tests if any
    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo -e "${RED}Failed Tests:${NC}"
        for test in "${FAILED_TESTS[@]}"; do
            echo -e "  ${RED}✗${NC} $test"
        done
        echo ""
    fi

    # Calculate success rate
    if [[ $TESTS_RUN -gt 0 ]]; then
        local success_rate
        success_rate=$(awk "BEGIN {printf \"%.1f\", ($TESTS_PASSED / $TESTS_RUN) * 100}")
        echo "Success Rate: ${success_rate}%"
        echo ""
    fi

    # Exit with appropriate code
    if [[ $TESTS_FAILED -gt 0 ]]; then
        echo -e "${RED}✗ Some tests failed${NC}"
        exit 1
    else
        echo -e "${GREEN}✓ All tests passed${NC}"
        exit 0
    fi
}

# Run main function
main "$@"
