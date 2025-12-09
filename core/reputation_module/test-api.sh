#!/usr/bin/env bash
################################################################################
# WaddleBot Reputation Core Module API Test Script
################################################################################
#
# Comprehensive test suite for the Reputation Core Module API endpoints.
# Tests health checks, status, and module configuration.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set reputation module URL (default: http://localhost:8054)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   REPUTATION_URL      Base URL for reputation module (default: http://localhost:8054)
#   REPUTATION_API_KEY  API key for authenticated endpoints
#   VERBOSE             Enable verbose output (true/false)
#
# Exit Codes:
#   0 - All tests passed
#   1 - One or more tests failed
#
################################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Configuration
REPUTATION_URL="${REPUTATION_URL:-http://localhost:8054}"
REPUTATION_API_KEY="${REPUTATION_API_KEY:-}"
VERBOSE="${VERBOSE:-false}"
SKIP_AUTH=false

################################################################################
# Helper Functions
################################################################################

print_help() {
    sed -n '2,/^$/p' "$0" | sed 's/^# //g; s/^#//g'
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $*"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $*"
}

log_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $*"
}

log_verbose() {
    if [[ "$VERBOSE" == "true" ]]; then
        echo -e "${BLUE}[VERBOSE]${NC} $*"
    fi
}

# Check if required commands are available
check_requirements() {
    local missing=()

    if ! command -v curl &> /dev/null; then
        missing+=("curl")
    fi

    if ! command -v jq &> /dev/null; then
        missing+=("jq")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        log_error "Missing required commands: ${missing[*]}"
        log_error "Please install missing dependencies and try again"
        exit 1
    fi
}

# Make HTTP request and return response
make_request() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local auth_required="${4:-false}"

    local url="${REPUTATION_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$REPUTATION_API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${REPUTATION_API_KEY}")
    fi

    log_verbose "Request: $method $url"
    [[ -n "$data" ]] && log_verbose "Data: $data"

    local response
    local http_code

    if [[ -n "$data" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            "${headers[@]}" \
            -d "$data" 2>&1) || true
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
            "${headers[@]}" 2>&1) || true
    fi

    # Extract HTTP code from last line
    http_code=$(echo "$response" | tail -n1)
    response=$(echo "$response" | sed '$d')

    log_verbose "HTTP Code: $http_code"
    log_verbose "Response: $response"

    # Return both response and HTTP code
    echo "$response"
    echo "$http_code"
}

# Run a test case
run_test() {
    local test_name="$1"
    local method="$2"
    local endpoint="$3"
    local data="${4:-}"
    local expected_code="${5:-200}"
    local auth_required="${6:-false}"
    local check_function="${7:-}"

    ((TESTS_RUN++))

    # Skip authenticated tests if no API key and skip_auth is set
    if [[ "$auth_required" == "true" ]] && [[ -z "$REPUTATION_API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
        log_skip "$test_name (no API key)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    log_info "Running: $test_name"

    # Make request
    local result
    result=$(make_request "$method" "$endpoint" "$data" "$auth_required")

    local response
    local http_code
    response=$(echo "$result" | head -n -1)
    http_code=$(echo "$result" | tail -n1)

    # Check HTTP code
    if [[ "$http_code" != "$expected_code" ]]; then
        log_error "$test_name - Expected HTTP $expected_code, got $http_code"
        ((TESTS_FAILED++))
        return 1
    fi

    # Check if response is valid JSON (unless it's empty or plain text)
    if [[ -n "$response" ]] && [[ "$response" != "null" ]]; then
        # Skip JSON validation for Prometheus metrics (plain text format)
        if [[ "$endpoint" != "/metrics" ]]; then
            if ! echo "$response" | jq . > /dev/null 2>&1; then
                log_error "$test_name - Invalid JSON response"
                ((TESTS_FAILED++))
                return 1
            fi
        fi
    fi

    # Run custom check function if provided
    if [[ -n "$check_function" ]]; then
        if ! $check_function "$response"; then
            log_error "$test_name - Custom validation failed"
            ((TESTS_FAILED++))
            return 1
        fi
    fi

    log_success "$test_name"
    ((TESTS_PASSED++))
    return 0
}

################################################################################
# Test Validation Functions
################################################################################

check_health_response() {
    local response="$1"

    # Check for status field
    if ! echo "$response" | jq -e '.status' > /dev/null 2>&1; then
        log_error "Missing 'status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.status')

    if [[ "$status" != "healthy" ]]; then
        log_error "Service not healthy: $status"
        return 1
    fi

    # Check for module field
    if ! echo "$response" | jq -e '.module' > /dev/null 2>&1; then
        log_error "Missing 'module' field"
        return 1
    fi

    local module
    module=$(echo "$response" | jq -r '.module')

    if [[ "$module" != "reputation_module" ]]; then
        log_error "Wrong module name: $module (expected 'reputation_module')"
        return 1
    fi

    # Check for version field
    if ! echo "$response" | jq -e '.version' > /dev/null 2>&1; then
        log_error "Missing 'version' field"
        return 1
    fi

    return 0
}

check_healthz_response() {
    local response="$1"

    # Check for status field
    if ! echo "$response" | jq -e '.status' > /dev/null 2>&1; then
        log_error "Missing 'status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.status')

    # Status should be "healthy" or "degraded"
    if [[ "$status" != "healthy" ]] && [[ "$status" != "degraded" ]]; then
        log_error "Invalid status: $status (expected 'healthy' or 'degraded')"
        return 1
    fi

    # Check for checks field
    if ! echo "$response" | jq -e '.checks' > /dev/null 2>&1; then
        log_error "Missing 'checks' field"
        return 1
    fi

    # Validate checks is an object
    if ! echo "$response" | jq -e '.checks | type == "object"' > /dev/null 2>&1; then
        log_error "'checks' field must be an object"
        return 1
    fi

    return 0
}

check_metrics_response() {
    local response="$1"

    # Metrics should be in Prometheus text format
    if ! echo "$response" | grep -q "waddlebot_info"; then
        log_error "Missing 'waddlebot_info' metric"
        return 1
    fi

    if ! echo "$response" | grep -q "waddlebot_requests_total"; then
        log_error "Missing 'waddlebot_requests_total' metric"
        return 1
    fi

    # Verify module name in metrics
    if ! echo "$response" | grep -q 'module="reputation_module"'; then
        log_error "Missing module label in metrics"
        return 1
    fi

    return 0
}

check_status_response() {
    local response="$1"

    # Check for data field (standardized API response)
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for status field in data
    if ! echo "$response" | jq -e '.data.status' > /dev/null 2>&1; then
        log_error "Missing 'data.status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.data.status')

    if [[ "$status" != "operational" ]]; then
        log_error "Service not operational: $status"
        return 1
    fi

    # Check for module field
    if ! echo "$response" | jq -e '.data.module' > /dev/null 2>&1; then
        log_error "Missing 'data.module' field"
        return 1
    fi

    local module
    module=$(echo "$response" | jq -r '.data.module')

    if [[ "$module" != "reputation_module" ]]; then
        log_error "Wrong module name: $module (expected 'reputation_module')"
        return 1
    fi

    return 0
}

################################################################################
# Test Cases
################################################################################

test_health() {
    run_test \
        "GET /health" \
        "GET" \
        "/health" \
        "" \
        "200" \
        "false" \
        "check_health_response"
}

test_healthz() {
    run_test \
        "GET /healthz" \
        "GET" \
        "/healthz" \
        "" \
        "200" \
        "false" \
        "check_healthz_response"
}

test_metrics() {
    run_test \
        "GET /metrics" \
        "GET" \
        "/metrics" \
        "" \
        "200" \
        "false" \
        "check_metrics_response"
}

test_status() {
    run_test \
        "GET /api/v1/status" \
        "GET" \
        "/api/v1/status" \
        "" \
        "200" \
        "false" \
        "check_status_response"
}

test_invalid_endpoint() {
    run_test \
        "GET /api/v1/nonexistent" \
        "GET" \
        "/api/v1/nonexistent" \
        "" \
        "404" \
        "false"
}

test_invalid_method() {
    run_test \
        "DELETE /api/v1/status" \
        "DELETE" \
        "/api/v1/status" \
        "" \
        "405" \
        "false"
}

test_root_endpoint() {
    run_test \
        "GET / (root endpoint)" \
        "GET" \
        "/" \
        "" \
        "404" \
        "false"
}

################################################################################
# Reputation Public API Tests
################################################################################

check_tiers_response() {
    local response="$1"

    # Check for tiers array
    if ! echo "$response" | jq -e '.tiers' > /dev/null 2>&1; then
        log_error "Missing 'tiers' field"
        return 1
    fi

    # Should have 5 tiers (exceptional, very_good, good, fair, poor)
    local tier_count
    tier_count=$(echo "$response" | jq '.tiers | length')

    if [[ "$tier_count" != "5" ]]; then
        log_error "Expected 5 tiers, got $tier_count"
        return 1
    fi

    return 0
}

check_weights_response() {
    local response="$1"

    # Check for weights object
    if ! echo "$response" | jq -e '.weights' > /dev/null 2>&1; then
        log_error "Missing 'weights' field"
        return 1
    fi

    # Check for essential weight fields
    if ! echo "$response" | jq -e '.weights.chat_message' > /dev/null 2>&1; then
        log_error "Missing 'weights.chat_message' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.weights.ban' > /dev/null 2>&1; then
        log_error "Missing 'weights.ban' field"
        return 1
    fi

    return 0
}

check_leaderboard_response() {
    local response="$1"

    # Check for success and users array
    if ! echo "$response" | jq -e '.success' > /dev/null 2>&1; then
        log_error "Missing 'success' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.users' > /dev/null 2>&1; then
        log_error "Missing 'users' field"
        return 1
    fi

    return 0
}

check_reputation_response() {
    local response="$1"

    # Check for score field
    if ! echo "$response" | jq -e '.score' > /dev/null 2>&1; then
        log_error "Missing 'score' field"
        return 1
    fi

    local score
    score=$(echo "$response" | jq '.score')

    # Score should be between 300-850
    if [[ "$score" -lt 300 ]] || [[ "$score" -gt 850 ]]; then
        log_error "Score $score out of FICO range (300-850)"
        return 1
    fi

    # Check for tier field
    if ! echo "$response" | jq -e '.tier' > /dev/null 2>&1; then
        log_error "Missing 'tier' field"
        return 1
    fi

    return 0
}

check_event_response() {
    local response="$1"

    # Check for success or processed field
    if ! echo "$response" | jq -e '.success // .processed' > /dev/null 2>&1; then
        log_error "Missing 'success' or 'processed' field"
        return 1
    fi

    return 0
}

test_get_tiers() {
    run_test \
        "GET /api/v1/reputation/tiers" \
        "GET" \
        "/api/v1/reputation/tiers" \
        "" \
        "200" \
        "false" \
        "check_tiers_response"
}

test_get_default_weights() {
    run_test \
        "GET /api/v1/reputation/weights" \
        "GET" \
        "/api/v1/reputation/weights" \
        "" \
        "200" \
        "false" \
        "check_weights_response"
}

test_get_community_leaderboard() {
    run_test \
        "GET /api/v1/reputation/1/leaderboard" \
        "GET" \
        "/api/v1/reputation/1/leaderboard?limit=10" \
        "" \
        "200" \
        "false" \
        "check_leaderboard_response"
}

test_get_user_reputation() {
    run_test \
        "GET /api/v1/reputation/1/user/1" \
        "GET" \
        "/api/v1/reputation/1/user/1" \
        "" \
        "200" \
        "false" \
        "check_reputation_response"
}

test_get_user_history() {
    run_test \
        "GET /api/v1/reputation/1/user/1/history" \
        "GET" \
        "/api/v1/reputation/1/user/1/history?limit=10" \
        "" \
        "200" \
        "false"
}

test_get_global_reputation() {
    run_test \
        "GET /api/v1/reputation/global/1" \
        "GET" \
        "/api/v1/reputation/global/1" \
        "" \
        "200" \
        "false"
}

test_get_global_leaderboard() {
    run_test \
        "GET /api/v1/reputation/global/leaderboard" \
        "GET" \
        "/api/v1/reputation/global/leaderboard?limit=10" \
        "" \
        "200" \
        "false"
}

################################################################################
# Reputation Internal API Tests
################################################################################

test_internal_receive_event() {
    local event_data='{"community_id": 1, "platform": "twitch", "platform_user_id": "test123", "event_type": "chat_message", "metadata": {"username": "testuser"}}'

    run_test \
        "POST /api/v1/internal/events" \
        "POST" \
        "/api/v1/internal/events" \
        "$event_data" \
        "200" \
        "true" \
        "check_event_response"
}

test_internal_receive_batch() {
    local batch_data='{"events": [{"community_id": 1, "platform": "twitch", "platform_user_id": "test123", "event_type": "chat_message"}, {"community_id": 1, "platform": "twitch", "platform_user_id": "test456", "event_type": "follow"}]}'

    run_test \
        "POST /api/v1/internal/events/batch" \
        "POST" \
        "/api/v1/internal/events/batch" \
        "$batch_data" \
        "200" \
        "true"
}

test_internal_quick_check() {
    run_test \
        "GET /api/v1/internal/check/1/1" \
        "GET" \
        "/api/v1/internal/check/1/1" \
        "" \
        "200" \
        "true"
}

test_internal_moderation() {
    local mod_data='{"community_id": 1, "user_id": 1, "action": "warn", "reason": "Test warning", "moderator_id": 1}'

    run_test \
        "POST /api/v1/internal/moderation" \
        "POST" \
        "/api/v1/internal/moderation" \
        "$mod_data" \
        "200" \
        "true"
}

################################################################################
# Reputation Admin API Tests
################################################################################

test_admin_set_reputation() {
    local set_data='{"score": 650, "reason": "Manual adjustment for testing"}'

    run_test \
        "PUT /api/v1/admin/1/reputation/1/set" \
        "PUT" \
        "/api/v1/admin/1/reputation/1/set" \
        "$set_data" \
        "200" \
        "true"
}

test_admin_get_config() {
    run_test \
        "GET /api/v1/admin/1/config" \
        "GET" \
        "/api/v1/admin/1/config" \
        "" \
        "200" \
        "true"
}

test_admin_update_config() {
    local config_data='{"auto_ban_enabled": false, "auto_ban_threshold": 400}'

    run_test \
        "PUT /api/v1/admin/1/config" \
        "PUT" \
        "/api/v1/admin/1/config" \
        "$config_data" \
        "200" \
        "true"
}

test_admin_at_risk_users() {
    run_test \
        "GET /api/v1/admin/1/at-risk" \
        "GET" \
        "/api/v1/admin/1/at-risk" \
        "" \
        "200" \
        "true"
}

test_admin_toggle_auto_ban() {
    local toggle_data='{"enabled": false}'

    run_test \
        "POST /api/v1/admin/1/auto-ban" \
        "POST" \
        "/api/v1/admin/1/auto-ban" \
        "$toggle_data" \
        "200" \
        "true"
}

################################################################################
# Main Execution
################################################################################

main() {
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help)
                print_help
                exit 0
                ;;
            --url)
                REPUTATION_URL="$2"
                shift 2
                ;;
            --api-key)
                REPUTATION_API_KEY="$2"
                shift 2
                ;;
            --verbose)
                VERBOSE="true"
                shift
                ;;
            --skip-auth)
                SKIP_AUTH="true"
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                print_help
                exit 1
                ;;
        esac
    done

    # Check requirements
    check_requirements

    # Print test configuration
    echo ""
    log_info "======================================================================"
    log_info "WaddleBot Reputation Core Module API Test Suite"
    log_info "======================================================================"
    log_info "Reputation Module URL: $REPUTATION_URL"
    log_info "API Key: ${REPUTATION_API_KEY:+[SET]}${REPUTATION_API_KEY:-[NOT SET]}"
    log_info "Verbose: $VERBOSE"
    log_info "Skip Auth Tests: $SKIP_AUTH"
    log_info "======================================================================"
    echo ""

    # Run tests
    log_info "Running Health & Metrics Tests..."
    test_health
    test_healthz
    test_metrics
    echo ""

    log_info "Running API Status Tests..."
    test_status
    echo ""

    log_info "Running Reputation Public API Tests..."
    test_get_tiers
    test_get_default_weights
    test_get_community_leaderboard
    test_get_user_reputation
    test_get_user_history
    test_get_global_reputation
    test_get_global_leaderboard
    echo ""

    log_info "Running Reputation Internal API Tests..."
    test_internal_receive_event
    test_internal_receive_batch
    test_internal_quick_check
    test_internal_moderation
    echo ""

    log_info "Running Reputation Admin API Tests..."
    test_admin_set_reputation
    test_admin_get_config
    test_admin_update_config
    test_admin_at_risk_users
    test_admin_toggle_auto_ban
    echo ""

    log_info "Running Error Handling Tests..."
    test_invalid_endpoint
    test_invalid_method
    test_root_endpoint
    echo ""

    # Print summary
    echo ""
    log_info "======================================================================"
    log_info "Test Summary"
    log_info "======================================================================"
    log_info "Total Tests:  $TESTS_RUN"
    log_success "Passed:       $TESTS_PASSED"
    log_error "Failed:       $TESTS_FAILED"
    log_skip "Skipped:      $TESTS_SKIPPED"
    log_info "======================================================================"
    echo ""

    # Exit with appropriate code
    if [[ $TESTS_FAILED -gt 0 ]]; then
        log_error "Some tests failed!"
        exit 1
    else
        log_success "All tests passed!"
        exit 0
    fi
}

# Run main function
main "$@"
