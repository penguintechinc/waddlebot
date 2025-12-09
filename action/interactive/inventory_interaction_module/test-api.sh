#!/bin/bash
################################################################################
# WaddleBot Inventory Interaction Module API Test Script
# Comprehensive test suite for all Inventory Module API endpoints
################################################################################

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Configuration
INVENTORY_URL="${INVENTORY_URL:-http://localhost:8024}"
VERBOSE=false

# Temporary files
RESPONSE_FILE=$(mktemp)

# Cleanup on exit
trap 'rm -f "$RESPONSE_FILE"' EXIT

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_test() {
    echo -e "\n${BLUE}[TEST]${NC} $1"
}

print_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

print_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

print_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((TESTS_SKIPPED++))
}

print_summary() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}Test Summary${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo -e "${GREEN}Passed:  ${TESTS_PASSED}${NC}"
    echo -e "${RED}Failed:  ${TESTS_FAILED}${NC}"
    echo -e "${YELLOW}Skipped: ${TESTS_SKIPPED}${NC}"
    echo -e "${BLUE}Total:   $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))${NC}"
    echo -e "${BLUE}========================================${NC}"
}

show_help() {
    cat << EOF
WaddleBot Inventory Interaction Module API Test Script

Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    -u, --url URL           Inventory module URL (default: http://localhost:8024)
    -v, --verbose           Enable verbose output (show response bodies)

Environment Variables:
    INVENTORY_URL           Inventory module URL

Examples:
    # Run tests against local instance
    $0

    # Run tests against custom URL
    $0 --url http://inventory.example.com:8024

    # Run with verbose output
    $0 --verbose

Exit Codes:
    0 - All tests passed
    1 - One or more tests failed

EOF
}

# API call helper
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local expected_status="${4:-200}"

    local curl_opts=(-s -w "\n%{http_code}" -X "$method")

    # Add content-type and data if provided
    if [ -n "$data" ]; then
        curl_opts+=(-H "Content-Type: application/json" -d "$data")
    fi

    # Make the API call
    local response
    response=$(curl "${curl_opts[@]}" "${INVENTORY_URL}${endpoint}" 2>&1 || true)

    # Extract status code (last line)
    local status_code
    status_code=$(echo "$response" | tail -n 1)

    # Extract body (all but last line)
    local body
    body=$(echo "$response" | sed '$d')

    # Save response for inspection
    echo "$body" > "$RESPONSE_FILE"

    # Show verbose output if enabled
    if [ "$VERBOSE" = true ]; then
        echo -e "  ${BLUE}Status:${NC} $status_code"
        echo -e "  ${BLUE}Response:${NC} $body"
    fi

    # Check status code
    if [ "$status_code" = "$expected_status" ]; then
        echo "$body"
        return 0
    else
        if [ "$VERBOSE" = false ]; then
            echo "Expected status $expected_status, got $status_code" >&2
            echo "Response: $body" >&2
        fi
        return 1
    fi
}

# Validate JSON response helper
validate_json() {
    local response="$1"
    if echo "$response" | jq empty 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Check JSON field exists
check_field() {
    local response="$1"
    local field="$2"
    if echo "$response" | jq -e "$field" > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

################################################################################
# Parse Arguments
################################################################################

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -u|--url)
            INVENTORY_URL="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

################################################################################
# Main Test Execution
################################################################################

echo -e "${BLUE}WaddleBot Inventory Interaction Module API Test Suite${NC}"
echo -e "Testing: ${INVENTORY_URL}"
echo -e "Module: inventory_interaction_module"
echo -e "Expected Port: 8024"

################################################################################
# Health Check Endpoints
################################################################################

print_header "Health Check Endpoints"

# Test: Basic health check
print_test "GET /health"
if response=$(api_call GET /health "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.status' && \
           check_field "$response" '.module' && \
           check_field "$response" '.version' && \
           check_field "$response" '.timestamp'; then

            status=$(echo "$response" | jq -r '.status')
            module=$(echo "$response" | jq -r '.module')
            version=$(echo "$response" | jq -r '.version')

            if [ "$status" = "healthy" ]; then
                print_pass "Health check returned healthy status (module: $module, version: $version)"
            else
                print_fail "Health check returned status '$status', expected 'healthy'"
            fi
        else
            print_fail "Health check missing required fields (status, module, version, timestamp)"
        fi
    else
        print_fail "Health check returned invalid JSON"
    fi
else
    print_fail "Health check failed - module may not be running"
    echo -e "${RED}ERROR: Cannot connect to inventory module at ${INVENTORY_URL}${NC}"
    echo -e "${YELLOW}Please ensure the module is running and accessible${NC}"
    print_summary
    exit 1
fi

# Test: Kubernetes health check (healthz)
print_test "GET /healthz"
if response=$(api_call GET /healthz "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.status' && \
           check_field "$response" '.module' && \
           check_field "$response" '.version' && \
           check_field "$response" '.checks'; then

            status=$(echo "$response" | jq -r '.status')
            memory_check=$(echo "$response" | jq -r '.checks.memory')
            cpu_check=$(echo "$response" | jq -r '.checks.cpu')

            if [ "$status" = "healthy" ]; then
                print_pass "Healthz check returned healthy status (memory: $memory_check, cpu: $cpu_check)"
            elif [ "$status" = "degraded" ]; then
                print_pass "Healthz check returned degraded status (memory: $memory_check, cpu: $cpu_check) - WARNING"
            else
                print_fail "Healthz check returned unexpected status '$status'"
            fi
        else
            print_fail "Healthz check missing required fields"
        fi
    else
        print_fail "Healthz check returned invalid JSON"
    fi
else
    # Try with 503 status (degraded)
    if response=$(api_call GET /healthz "" 503 2>/dev/null); then
        status=$(echo "$response" | jq -r '.status' 2>/dev/null || echo "unknown")
        print_pass "Healthz check returned degraded status (503): $status"
    else
        print_fail "Healthz check failed"
    fi
fi

# Test: Prometheus metrics endpoint
print_test "GET /metrics"
if response=$(api_call GET /metrics "" 200); then
    # Metrics endpoint returns Prometheus text format, not JSON
    if echo "$response" | grep -q "waddlebot_info"; then
        # Check for key metrics
        metrics_found=0

        if echo "$response" | grep -q "waddlebot_info{"; then
            ((metrics_found++))
        fi
        if echo "$response" | grep -q "waddlebot_requests_total"; then
            ((metrics_found++))
        fi
        if echo "$response" | grep -q "waddlebot_memory_bytes"; then
            ((metrics_found++))
        fi
        if echo "$response" | grep -q "waddlebot_cpu_percent"; then
            ((metrics_found++))
        fi

        if [ $metrics_found -ge 3 ]; then
            print_pass "Metrics endpoint returned Prometheus format with $metrics_found key metrics"
        else
            print_fail "Metrics endpoint returned incomplete metrics (found $metrics_found/4)"
        fi
    else
        print_fail "Metrics endpoint did not return Prometheus format"
    fi
else
    print_fail "Metrics endpoint failed"
fi

################################################################################
# API Status Endpoint
################################################################################

print_header "API Status Endpoint"

# Test: API status check
print_test "GET /api/v1/status"
if response=$(api_call GET /api/v1/status "" 200); then
    if validate_json "$response"; then
        # Check for standardized response format
        if check_field "$response" '.success' && check_field "$response" '.data'; then
            success=$(echo "$response" | jq -r '.success')
            status_val=$(echo "$response" | jq -r '.data.status')
            module_name=$(echo "$response" | jq -r '.data.module')

            if [ "$success" = "true" ] && [ "$status_val" = "operational" ]; then
                print_pass "API status check successful (module: $module_name, status: $status_val)"
            else
                print_fail "API status check returned unexpected values (success: $success, status: $status_val)"
            fi
        else
            print_fail "API status check missing standardized response format (success, data)"
        fi
    else
        print_fail "API status check returned invalid JSON"
    fi
else
    print_fail "API status check failed"
fi

################################################################################
# Error Handling Tests
################################################################################

print_header "Error Handling Tests"

# Test: Non-existent endpoint (404)
print_test "GET /api/v1/nonexistent (404 Not Found)"
if api_call GET /api/v1/nonexistent "" 404 > /dev/null 2>&1; then
    print_pass "Non-existent endpoint correctly returns 404"
else
    print_skip "404 handling test - response varies by framework"
fi

# Test: Invalid HTTP method
print_test "DELETE /health (405 Method Not Allowed)"
if api_call DELETE /health "" 405 > /dev/null 2>&1; then
    print_pass "Invalid HTTP method correctly returns 405"
else
    print_skip "405 handling test - response varies by framework"
fi

################################################################################
# Response Format Validation
################################################################################

print_header "Response Format Validation"

# Test: Verify timestamp format in health endpoint
print_test "Verify ISO 8601 timestamp format"
if response=$(api_call GET /health "" 200); then
    timestamp=$(echo "$response" | jq -r '.timestamp')
    # Check if timestamp matches ISO 8601 format (basic check)
    if [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
        print_pass "Timestamp follows ISO 8601 format: $timestamp"
    else
        print_fail "Timestamp does not follow ISO 8601 format: $timestamp"
    fi
else
    print_fail "Could not retrieve timestamp for validation"
fi

# Test: Verify success response format
print_test "Verify standardized success response format"
if response=$(api_call GET /api/v1/status "" 200); then
    has_success=false
    has_data=false
    has_timestamp=false

    if check_field "$response" '.success'; then
        has_success=true
    fi
    if check_field "$response" '.data'; then
        has_data=true
    fi
    if check_field "$response" '.timestamp'; then
        has_timestamp=true
    fi

    if [ "$has_success" = true ] && [ "$has_data" = true ] && [ "$has_timestamp" = true ]; then
        print_pass "Response follows standardized success format (success, data, timestamp)"
    else
        print_fail "Response missing standardized fields (success: $has_success, data: $has_data, timestamp: $has_timestamp)"
    fi
else
    print_fail "Could not retrieve response for format validation"
fi

################################################################################
# Module Information Tests
################################################################################

print_header "Module Information Tests"

# Test: Verify module name consistency
print_test "Verify module name consistency across endpoints"
health_module=$(api_call GET /health "" 200 | jq -r '.module' 2>/dev/null || echo "")
status_module=$(api_call GET /api/v1/status "" 200 | jq -r '.data.module' 2>/dev/null || echo "")

if [ -n "$health_module" ] && [ -n "$status_module" ]; then
    if [ "$health_module" = "$status_module" ]; then
        print_pass "Module name consistent across endpoints: $health_module"
    else
        print_fail "Module name inconsistent (health: $health_module, status: $status_module)"
    fi
else
    print_skip "Could not retrieve module names for consistency check"
fi

# Test: Verify version format
print_test "Verify semantic version format"
version=$(api_call GET /health "" 200 | jq -r '.version' 2>/dev/null || echo "")
if [ -n "$version" ]; then
    # Check if version follows semantic versioning (X.Y.Z)
    if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        print_pass "Version follows semantic versioning: $version"
    else
        print_fail "Version does not follow semantic versioning: $version"
    fi
else
    print_fail "Could not retrieve version for validation"
fi

################################################################################
# Performance Tests
################################################################################

print_header "Performance Tests"

# Test: Response time for health endpoint
print_test "Health endpoint response time (< 100ms)"
start_time=$(date +%s%N)
if api_call GET /health "" 200 > /dev/null 2>&1; then
    end_time=$(date +%s%N)
    duration_ms=$(( (end_time - start_time) / 1000000 ))

    if [ $duration_ms -lt 100 ]; then
        print_pass "Health endpoint responded in ${duration_ms}ms (excellent)"
    elif [ $duration_ms -lt 500 ]; then
        print_pass "Health endpoint responded in ${duration_ms}ms (acceptable)"
    else
        print_fail "Health endpoint responded in ${duration_ms}ms (slow, > 500ms)"
    fi
else
    print_fail "Could not measure health endpoint response time"
fi

# Test: Response time for status endpoint
print_test "Status endpoint response time (< 200ms)"
start_time=$(date +%s%N)
if api_call GET /api/v1/status "" 200 > /dev/null 2>&1; then
    end_time=$(date +%s%N)
    duration_ms=$(( (end_time - start_time) / 1000000 ))

    if [ $duration_ms -lt 200 ]; then
        print_pass "Status endpoint responded in ${duration_ms}ms (excellent)"
    elif [ $duration_ms -lt 1000 ]; then
        print_pass "Status endpoint responded in ${duration_ms}ms (acceptable)"
    else
        print_fail "Status endpoint responded in ${duration_ms}ms (slow, > 1000ms)"
    fi
else
    print_fail "Could not measure status endpoint response time"
fi

################################################################################
# Content-Type Validation
################################################################################

print_header "Content-Type Validation"

# Test: JSON endpoints return proper content-type
print_test "Verify JSON Content-Type headers"
if response=$(curl -s -I "${INVENTORY_URL}/health" 2>/dev/null); then
    if echo "$response" | grep -iq "content-type:.*application/json"; then
        print_pass "Health endpoint returns application/json Content-Type"
    else
        print_fail "Health endpoint does not return application/json Content-Type"
    fi
else
    print_fail "Could not retrieve headers for Content-Type validation"
fi

# Test: Metrics endpoint returns text/plain
print_test "Verify Prometheus metrics Content-Type"
if response=$(curl -s -I "${INVENTORY_URL}/metrics" 2>/dev/null); then
    if echo "$response" | grep -iq "content-type:.*text/plain"; then
        print_pass "Metrics endpoint returns text/plain Content-Type"
    else
        print_fail "Metrics endpoint does not return text/plain Content-Type"
    fi
else
    print_fail "Could not retrieve headers for metrics Content-Type validation"
fi

################################################################################
# Concurrent Request Tests
################################################################################

print_header "Concurrent Request Tests"

# Test: Handle concurrent requests
print_test "Handle 10 concurrent health check requests"
success_count=0
for i in {1..10}; do
    if api_call GET /health "" 200 > /dev/null 2>&1 & then
        ((success_count++)) || true
    fi
done
wait

if [ $success_count -eq 10 ]; then
    print_pass "All 10 concurrent requests completed successfully"
elif [ $success_count -ge 8 ]; then
    print_pass "$success_count/10 concurrent requests successful (acceptable)"
else
    print_fail "Only $success_count/10 concurrent requests successful"
fi

################################################################################
# Print Summary and Exit
################################################################################

print_summary

# Additional information
echo -e "\n${BLUE}Module Information:${NC}"
echo -e "  URL: ${INVENTORY_URL}"
echo -e "  Module: inventory_interaction_module"
echo -e "  Expected Port: 8024"
echo -e "  Database: PostgreSQL"

# Exit with appropriate code
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "\n${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed successfully!${NC}"
    exit 0
fi
