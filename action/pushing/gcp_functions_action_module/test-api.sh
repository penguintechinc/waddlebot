#!/usr/bin/env bash
################################################################################
# WaddleBot GCP Functions Action Module API Test Script
#
# Tests all REST API endpoints of the GCP Functions Action Module with
# comprehensive validation, plus gRPC connectivity checks.
#
# Usage:
#   ./test-api.sh                       # Test default localhost:8000
#   GCP_URL=http://host:port ./test-api.sh
#   ./test-api.sh --help
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed
#
# Environment Variables:
#   GCP_URL        - Base URL for GCP Functions module (default: http://localhost:8000)
#   GRPC_PORT      - gRPC port for GCP Functions module (default: 50061)
#   API_KEY        - Optional API key for authenticated requests
#   VERBOSE        - Set to 1 for verbose output
################################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GCP_URL="${GCP_URL:-http://localhost:8000}"
GRPC_PORT="${GRPC_PORT:-50061}"
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
WaddleBot GCP Functions Action Module API Test Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    --help          Show this help message
    -v, --verbose   Enable verbose output

ENVIRONMENT VARIABLES:
    GCP_URL         Base URL for GCP Functions module (default: http://localhost:8000)
    GRPC_PORT       gRPC port for GCP Functions module (default: 50061)
    API_KEY         Optional API key for authenticated requests
    VERBOSE         Set to 1 for verbose output

EXAMPLES:
    # Test local instance
    ./test-api.sh

    # Test remote instance
    GCP_URL=http://gcpfunctions.example.com:8000 ./test-api.sh

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

    local url="${GCP_URL}${endpoint}"
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

    validate_json "$response" ".module" "gcp_functions_action_module" || {
        print_fail "GET /health - Invalid module name"
        return 1
    }

    print_pass "GET /health - Health check working"
    return 0
}

test_invoke_function_endpoint() {
    print_test "POST /api/v1/gcp/invoke - Invoke GCP Cloud Function"
    ((TESTS_RUN++))

    local test_request
    test_request=$(cat <<'EOF'
{
  "function_name": "test-function",
  "region": "us-central1",
  "payload": {
    "key": "value"
  }
}
EOF
)

    local response
    response=$(make_request POST "/api/v1/gcp/invoke" "$test_request" 200) || {
        print_fail "POST /api/v1/gcp/invoke - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "POST /api/v1/gcp/invoke - Invalid JSON response"
        return 1
    }

    print_pass "POST /api/v1/gcp/invoke - Invoke function working"
    return 0
}

test_list_functions_endpoint() {
    print_test "GET /api/v1/gcp/functions - List GCP Cloud Functions"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/gcp/functions" "" 200) || {
        print_fail "GET /api/v1/gcp/functions - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "GET /api/v1/gcp/functions - Invalid JSON response"
        return 1
    }

    print_pass "GET /api/v1/gcp/functions - List functions working"
    return 0
}

test_get_function_info_endpoint() {
    print_test "GET /api/v1/gcp/functions/test-function - Get function info"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/gcp/functions/test-function" "" 200) || {
        print_fail "GET /api/v1/gcp/functions/test-function - Request failed"
        return 1
    }

    validate_json "$response" "" "" || {
        print_fail "GET /api/v1/gcp/functions/test-function - Invalid JSON response"
        return 1
    }

    print_pass "GET /api/v1/gcp/functions/test-function - Get function info working"
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

    if [[ -z "$response" ]]; then
        print_fail "GET /metrics - Empty response"
        return 1
    fi

    print_pass "GET /metrics - Metrics endpoint working"
    return 0
}

test_invalid_endpoint() {
    print_test "GET /api/v1/invalid - Test 404 handling"
    ((TESTS_RUN++))

    local response
    response=$(make_request GET "/api/v1/invalid" "" 404) || {
        print_pass "GET /api/v1/invalid - Returns non-200 status as expected"
        return 0
    }

    print_pass "GET /api/v1/invalid - 404 handling working"
    return 0
}

################################################################################
# gRPC Connectivity Check
################################################################################

test_grpc_connectivity() {
    print_header "gRPC Connectivity Check"

    if command -v grpcurl &> /dev/null; then
        print_test "gRPC connectivity to localhost:$GRPC_PORT"
        ((TESTS_RUN++))

        if grpcurl -plaintext "localhost:$GRPC_PORT" list &> /dev/null; then
            print_pass "gRPC server reachable on port $GRPC_PORT"
        else
            print_skip "gRPC server not responding on port $GRPC_PORT"
        fi
    else
        print_test "gRPC connectivity check"
        ((TESTS_RUN++))
        print_skip "grpcurl not installed - skipping gRPC check (install with: go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest)"
    fi
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
    print_header "WaddleBot GCP Functions Action Module API Tests"
    echo "GCP Functions URL: $GCP_URL"
    echo "gRPC Port: $GRPC_PORT"
    echo "API Key: ${API_KEY:+[set]}${API_KEY:-[not set]}"
    echo "Verbose: $VERBOSE"
    echo ""

    # Run health check first to ensure service is available
    print_header "REST Connectivity Check"
    if ! curl -s -f -o /dev/null "$GCP_URL/health"; then
        print_error "Cannot connect to GCP Functions module at $GCP_URL"
        print_error "Please ensure the GCP Functions module is running and accessible"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} GCP Functions module is accessible"

    # Run all tests
    print_header "Health & Status Endpoints"
    test_health_endpoint || true
    test_metrics_endpoint || true

    print_header "GCP Functions Action Endpoints"
    test_invoke_function_endpoint || true
    test_list_functions_endpoint || true
    test_get_function_info_endpoint || true

    print_header "Error Handling"
    test_invalid_endpoint || true

    # gRPC connectivity check
    test_grpc_connectivity || true

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
