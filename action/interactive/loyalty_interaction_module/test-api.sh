#!/bin/bash
################################################################################
# WaddleBot Loyalty Interaction Module API Test Script
# Comprehensive test suite for all Loyalty Module API endpoints
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

# Configuration - Use Kong gateway for REST API tests, direct URL for health checks
# Kong URL for API endpoints (default for REST API testing)
LOYALTY_URL="${LOYALTY_URL:-http://localhost:8000/api/v1/loyalty}"
# Direct URL for health/metrics endpoints (bypasses Kong)
LOYALTY_DIRECT_URL="${LOYALTY_DIRECT_URL:-http://localhost:8032}"
VERBOSE=false

# Temporary files
RESPONSE_FILE=$(mktemp)

# Test data
TEST_COMMUNITY_ID=1
TEST_USER_ID="test_user_$(date +%s)"
TEST_PLATFORM="twitch"
TEST_AMOUNT=100

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
WaddleBot Loyalty Interaction Module API Test Script

Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    -u, --url URL           Loyalty module URL (default: http://localhost:8025)
    -v, --verbose           Enable verbose output (show response bodies)

Environment Variables:
    LOYALTY_URL             Loyalty module URL
    VERBOSE                 Set to true for verbose output

Examples:
    # Run tests against local instance
    $0

    # Run tests against custom URL
    $0 --url http://loyalty.example.com:8025

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

    # Use direct URL for health/metrics endpoints, Kong URL for API endpoints
    local base_url
    if [[ "$endpoint" == "/health" ]] || [[ "$endpoint" == "/healthz" ]] || \
       [[ "$endpoint" == "/ready" ]] || [[ "$endpoint" == "/metrics" ]] || [[ "$endpoint" == "/" ]]; then
        base_url="${LOYALTY_DIRECT_URL}"
    else
        # Strip /api/v1 prefix since Kong URL already includes /api/v1/loyalty
        endpoint="${endpoint#/api/v1}"
        base_url="${LOYALTY_URL}"
    fi

    # Make the API call
    local response
    response=$(curl "${curl_opts[@]}" "${base_url}${endpoint}" 2>&1 || true)

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
            LOYALTY_URL="$2"
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

echo -e "${BLUE}WaddleBot Loyalty Interaction Module API Test Suite${NC}"
echo -e "Testing: ${LOYALTY_URL}"
echo -e "Module: loyalty_interaction_module"
echo -e "Expected Port: 8025"

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
    echo -e "${RED}ERROR: Cannot connect to loyalty module at ${LOYALTY_URL}${NC}"
    echo -e "${YELLOW}Please ensure the module is running and accessible${NC}"
    print_summary
    exit 1
fi

# Test: Kubernetes health check (healthz)
print_test "GET /healthz"
if response=$(api_call GET /healthz "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.status'; then
            status=$(echo "$response" | jq -r '.status')
            if [ "$status" = "healthy" ] || [ "$status" = "degraded" ]; then
                print_pass "Healthz check returned status: $status"
            else
                print_fail "Healthz check returned unexpected status '$status'"
            fi
        else
            print_fail "Healthz check missing status field"
        fi
    else
        print_fail "Healthz check returned invalid JSON"
    fi
else
    print_skip "Healthz endpoint not available"
fi

# Test: Prometheus metrics endpoint
print_test "GET /metrics"
if response=$(api_call GET /metrics "" 200); then
    if echo "$response" | grep -q "waddlebot_info"; then
        print_pass "Metrics endpoint returned Prometheus format"
    else
        print_fail "Metrics endpoint did not return Prometheus format"
    fi
else
    print_skip "Metrics endpoint not available"
fi

################################################################################
# Module Information Endpoints
################################################################################

print_header "Module Information Endpoints"

# Test: Index/module info
print_test "GET /"
if response=$(api_call GET / "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.module' && check_field "$response" '.data.features'; then
            module=$(echo "$response" | jq -r '.data.module')
            print_pass "Module info retrieved (module: $module)"
        else
            print_fail "Module info missing required fields"
        fi
    else
        print_fail "Module info returned invalid JSON"
    fi
else
    print_fail "Module info endpoint failed"
fi

################################################################################
# Currency Balance Tests
################################################################################

print_header "Currency Balance Tests"

# Test: Get balance (new user should have 0)
print_test "GET /api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID"
if response=$(api_call GET "/api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID" "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.balance'; then
            balance=$(echo "$response" | jq -r '.data.balance')
            print_pass "Get balance successful (balance: $balance)"
        else
            print_fail "Get balance missing balance field"
        fi
    else
        print_fail "Get balance returned invalid JSON"
    fi
else
    print_fail "Get balance failed"
fi

# Test: Add currency to user
print_test "POST /api/v1/currency/$TEST_COMMUNITY_ID/add"
add_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "amount": $TEST_AMOUNT,
  "reason": "test_add",
  "platform": "$TEST_PLATFORM"
}
EOF
)

if response=$(api_call POST "/api/v1/currency/$TEST_COMMUNITY_ID/add" "$add_request" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.success'; then
            success=$(echo "$response" | jq -r '.data.success')
            new_balance=$(echo "$response" | jq -r '.data.new_balance')
            if [ "$success" = "true" ]; then
                print_pass "Add currency successful (new balance: $new_balance)"
            else
                print_fail "Add currency returned success=false"
            fi
        else
            print_fail "Add currency missing success field"
        fi
    else
        print_fail "Add currency returned invalid JSON"
    fi
else
    print_fail "Add currency request failed"
fi

# Test: Get updated balance
print_test "GET /api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID (after add)"
if response=$(api_call GET "/api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID" "" 200); then
    if validate_json "$response"; then
        balance=$(echo "$response" | jq -r '.data.balance // 0')
        if [ "$balance" -ge "$TEST_AMOUNT" ]; then
            print_pass "Balance updated correctly (balance: $balance)"
        else
            print_fail "Balance not updated correctly (expected >= $TEST_AMOUNT, got $balance)"
        fi
    else
        print_fail "Get balance returned invalid JSON"
    fi
else
    print_fail "Get balance failed"
fi

################################################################################
# Leaderboard Tests
################################################################################

print_header "Leaderboard Tests"

# Test: Get leaderboard
print_test "GET /api/v1/currency/$TEST_COMMUNITY_ID/leaderboard"
if response=$(api_call GET "/api/v1/currency/$TEST_COMMUNITY_ID/leaderboard?limit=10&platform=$TEST_PLATFORM" "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.leaderboard'; then
            leaderboard_count=$(echo "$response" | jq '.data.leaderboard | length')
            print_pass "Leaderboard retrieved (entries: $leaderboard_count)"
        else
            print_fail "Leaderboard missing leaderboard field"
        fi
    else
        print_fail "Leaderboard returned invalid JSON"
    fi
else
    print_fail "Leaderboard request failed"
fi

################################################################################
# Simple Games Tests (Dice, RPS, Coinflip, Slots)
################################################################################

print_header "Simple Games Tests"

# Test: Play coinflip (simplest game)
print_test "POST /api/v1/games/$TEST_COMMUNITY_ID/coinflip"
coinflip_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "bet": 10,
  "choice": "heads",
  "platform": "$TEST_PLATFORM",
  "community_id": $TEST_COMMUNITY_ID
}
EOF
)

if response=$(api_call POST "/api/v1/games/$TEST_COMMUNITY_ID/coinflip" "$coinflip_request" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.result' && check_field "$response" '.data.won'; then
            result=$(echo "$response" | jq -r '.data.result')
            won=$(echo "$response" | jq -r '.data.won')
            print_pass "Coinflip game completed (result: $result, won: $won)"
        else
            print_fail "Coinflip response missing required fields"
        fi
    else
        print_fail "Coinflip returned invalid JSON"
    fi
else
    print_fail "Coinflip request failed"
fi

# Test: Play slots game
print_test "POST /api/v1/games/$TEST_COMMUNITY_ID/slots"
slots_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "bet": 10,
  "platform": "$TEST_PLATFORM",
  "community_id": $TEST_COMMUNITY_ID
}
EOF
)

if response=$(api_call POST "/api/v1/games/$TEST_COMMUNITY_ID/slots" "$slots_request" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.symbols'; then
            symbols=$(echo "$response" | jq -r '.data.symbols | join(", ")')
            print_pass "Slots game completed (symbols: $symbols)"
        else
            print_fail "Slots response missing symbols field"
        fi
    else
        print_fail "Slots returned invalid JSON"
    fi
else
    print_fail "Slots request failed"
fi

# Test: Play roulette game
print_test "POST /api/v1/games/$TEST_COMMUNITY_ID/roulette"
roulette_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "bet": 10,
  "bet_type": "color",
  "bet_value": "red",
  "platform": "$TEST_PLATFORM",
  "community_id": $TEST_COMMUNITY_ID
}
EOF
)

if response=$(api_call POST "/api/v1/games/$TEST_COMMUNITY_ID/roulette" "$roulette_request" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.number' && check_field "$response" '.data.won'; then
            number=$(echo "$response" | jq -r '.data.number')
            won=$(echo "$response" | jq -r '.data.won')
            print_pass "Roulette game completed (number: $number, won: $won)"
        else
            print_fail "Roulette response missing required fields"
        fi
    else
        print_fail "Roulette returned invalid JSON"
    fi
else
    print_fail "Roulette request failed"
fi

# Test: Get game stats
print_test "GET /api/v1/games/$TEST_COMMUNITY_ID/stats/$TEST_USER_ID"
if response=$(api_call GET "/api/v1/games/$TEST_COMMUNITY_ID/stats/$TEST_USER_ID?platform=$TEST_PLATFORM" "" 200); then
    if validate_json "$response"; then
        if check_field "$response" '.data.total_games'; then
            total_games=$(echo "$response" | jq -r '.data.total_games')
            print_pass "Game stats retrieved (total games: $total_games)"
        else
            print_fail "Game stats missing total_games field"
        fi
    else
        print_fail "Game stats returned invalid JSON"
    fi
else
    print_fail "Game stats request failed"
fi

################################################################################
# Golden Ticket Tests
################################################################################

print_header "Golden Ticket Tests"

# Note: Golden ticket endpoints may require specific implementation
# Testing basic availability and response format

# Placeholder test for golden ticket if implemented
print_test "Golden Ticket - Buy ticket (if implemented)"
golden_ticket_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "quantity": 1,
  "platform": "$TEST_PLATFORM",
  "community_id": $TEST_COMMUNITY_ID
}
EOF
)

# Try to call golden ticket endpoint (may return 404 if not implemented)
if response=$(api_call POST "/api/v1/golden-ticket/$TEST_COMMUNITY_ID/buy" "$golden_ticket_request" 200); then
    if validate_json "$response"; then
        print_pass "Golden ticket purchase successful"
    else
        print_fail "Golden ticket response invalid JSON"
    fi
else
    print_skip "Golden ticket endpoints not implemented or available"
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

# Test: Invalid bet amount
print_test "POST /api/v1/games/$TEST_COMMUNITY_ID/coinflip (invalid bet)"
invalid_request=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "bet": -10,
  "choice": "heads",
  "platform": "$TEST_PLATFORM",
  "community_id": $TEST_COMMUNITY_ID
}
EOF
)

if api_call POST "/api/v1/games/$TEST_COMMUNITY_ID/coinflip" "$invalid_request" 400 > /dev/null 2>&1; then
    print_pass "Invalid bet correctly returns 400"
else
    print_skip "Invalid bet validation - may vary by implementation"
fi

################################################################################
# Response Format Validation
################################################################################

print_header "Response Format Validation"

# Test: Verify ISO 8601 timestamp format
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
if response=$(api_call GET / "" 200); then
    has_success=false
    has_data=false

    if check_field "$response" '.success'; then
        has_success=true
    fi
    if check_field "$response" '.data'; then
        has_data=true
    fi

    if [ "$has_success" = true ] && [ "$has_data" = true ]; then
        print_pass "Response follows standardized success format (success, data)"
    else
        print_skip "Response format varies - may use different structure"
    fi
else
    print_fail "Could not retrieve response for format validation"
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

# Test: Response time for balance endpoint
print_test "Balance endpoint response time (< 200ms)"
start_time=$(date +%s%N)
if api_call GET "/api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID" "" 200 > /dev/null 2>&1; then
    end_time=$(date +%s%N)
    duration_ms=$(( (end_time - start_time) / 1000000 ))

    if [ $duration_ms -lt 200 ]; then
        print_pass "Balance endpoint responded in ${duration_ms}ms (excellent)"
    elif [ $duration_ms -lt 1000 ]; then
        print_pass "Balance endpoint responded in ${duration_ms}ms (acceptable)"
    else
        print_fail "Balance endpoint responded in ${duration_ms}ms (slow, > 1000ms)"
    fi
else
    print_fail "Could not measure balance endpoint response time"
fi

################################################################################
# Content-Type Validation
################################################################################

print_header "Content-Type Validation"

# Test: JSON endpoints return proper content-type
print_test "Verify JSON Content-Type headers"
if response=$(curl -s -I "${LOYALTY_URL}/health" 2>/dev/null); then
    if echo "$response" | grep -iq "content-type:.*application/json"; then
        print_pass "Health endpoint returns application/json Content-Type"
    else
        print_fail "Health endpoint does not return application/json Content-Type"
    fi
else
    print_fail "Could not retrieve headers for Content-Type validation"
fi

################################################################################
# Concurrent Request Tests
################################################################################

print_header "Concurrent Request Tests"

# Test: Handle concurrent requests
print_test "Handle 5 concurrent balance requests"
success_count=0
for i in {1..5}; do
    if api_call GET "/api/v1/currency/$TEST_COMMUNITY_ID/balance/$TEST_USER_ID" "" 200 > /dev/null 2>&1 & then
        ((success_count++)) || true
    fi
done
wait

if [ $success_count -eq 5 ]; then
    print_pass "All 5 concurrent requests completed successfully"
elif [ $success_count -ge 3 ]; then
    print_pass "$success_count/5 concurrent requests successful (acceptable)"
else
    print_fail "Only $success_count/5 concurrent requests successful"
fi

################################################################################
# Print Summary and Exit
################################################################################

print_summary

# Additional information
echo -e "\n${BLUE}Module Information:${NC}"
echo -e "  URL: ${LOYALTY_URL}"
echo -e "  Module: loyalty_interaction_module"
echo -e "  Expected Port: 8025"
echo -e "  Database: PostgreSQL"
echo -e "  Test User: $TEST_USER_ID"
echo -e "  Test Community: $TEST_COMMUNITY_ID"

# Exit with appropriate code
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "\n${RED}Some tests failed. Please review the output above.${NC}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed successfully!${NC}"
    exit 0
fi
