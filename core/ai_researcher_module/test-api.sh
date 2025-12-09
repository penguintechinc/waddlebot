#!/usr/bin/env bash
################################################################################
# WaddleBot AI Researcher Core Module API Test Script
################################################################################
#
# Comprehensive test suite for the AI Researcher Core Module API endpoints.
# Tests health checks, status, research endpoints, and admin configuration.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set AI researcher module URL (default: http://localhost:8055)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   AI_RESEARCHER_URL      Base URL for AI researcher module (default: http://localhost:8055)
#   API_KEY                API key for authenticated endpoints
#   VERBOSE                Enable verbose output (true/false)
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
AI_RESEARCHER_URL="${AI_RESEARCHER_URL:-http://localhost:8055}"
API_KEY="${API_KEY:-}"
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

    local url="${AI_RESEARCHER_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${API_KEY}")
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
    if [[ "$auth_required" == "true" ]] && [[ -z "$API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
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

    if [[ "$module" != "ai_researcher_module" ]]; then
        log_error "Wrong module name: $module (expected 'ai_researcher_module')"
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
    if ! echo "$response" | grep -q 'module="ai_researcher_module"'; then
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

    if [[ "$module" != "ai_researcher_module" ]]; then
        log_error "Wrong module name: $module (expected 'ai_researcher_module')"
        return 1
    fi

    # Check for features field
    if ! echo "$response" | jq -e '.data.features' > /dev/null 2>&1; then
        log_error "Missing 'data.features' field"
        return 1
    fi

    return 0
}

check_not_implemented_response() {
    local response="$1"

    # Should have success field
    if ! echo "$response" | jq -e '.data.success' > /dev/null 2>&1; then
        log_error "Missing 'data.success' field"
        return 1
    fi

    # Should have message field indicating not implemented
    if ! echo "$response" | jq -e '.data.message' > /dev/null 2>&1; then
        log_error "Missing 'data.message' field"
        return 1
    fi

    local message
    message=$(echo "$response" | jq -r '.data.message')

    if [[ "$message" != "Not implemented yet" ]]; then
        log_error "Expected 'Not implemented yet' message, got: $message"
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

################################################################################
# Research Endpoint Tests
################################################################################

test_research() {
    local research_data='{"community_id": 1, "user_id": 1, "platform": "twitch", "query": "What is Python?", "max_queries": 3}'

    run_test \
        "POST /api/v1/researcher/research" \
        "POST" \
        "/api/v1/researcher/research" \
        "$research_data" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

test_ask() {
    local ask_data='{"community_id": 1, "user_id": 1, "platform": "twitch", "question": "What was discussed today?", "include_context": true}'

    run_test \
        "POST /api/v1/researcher/ask" \
        "POST" \
        "/api/v1/researcher/ask" \
        "$ask_data" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

test_recall() {
    local recall_data='{"community_id": 1, "user_id": 1, "platform": "twitch", "query": "recent topics", "limit": 10}'

    run_test \
        "POST /api/v1/researcher/recall" \
        "POST" \
        "/api/v1/researcher/recall" \
        "$recall_data" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

test_summarize() {
    local summarize_data='{"community_id": 1, "user_id": 1, "platform": "twitch", "duration_minutes": 30, "topic": "stream highlights"}'

    run_test \
        "POST /api/v1/researcher/summarize" \
        "POST" \
        "/api/v1/researcher/summarize" \
        "$summarize_data" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

test_firehose() {
    local firehose_data='{"community_id": 1, "user_id": 1, "platform": "twitch", "platform_user_id": "test123", "message": "Hello world", "timestamp": "2025-12-06T12:00:00Z"}'

    run_test \
        "POST /api/v1/researcher/messages/firehose" \
        "POST" \
        "/api/v1/researcher/messages/firehose" \
        "$firehose_data" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

test_stream_end() {
    local stream_end_data='{"community_id": 1, "platform": "twitch", "ended_at": "2025-12-06T12:00:00Z", "duration_minutes": 120}'

    run_test \
        "POST /api/v1/researcher/stream/end" \
        "POST" \
        "/api/v1/researcher/stream/end" \
        "$stream_end_data" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

test_get_context() {
    run_test \
        "GET /api/v1/researcher/context/1" \
        "GET" \
        "/api/v1/researcher/context/1?limit=100" \
        "" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

test_get_memory() {
    run_test \
        "GET /api/v1/researcher/memory/1" \
        "GET" \
        "/api/v1/researcher/memory/1?limit=10" \
        "" \
        "501" \
        "false" \
        "check_not_implemented_response"
}

################################################################################
# Admin API Tests
################################################################################

test_admin_ai_insights() {
    run_test \
        "GET /api/v1/admin/1/ai-insights" \
        "GET" \
        "/api/v1/admin/1/ai-insights?limit=20" \
        "" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

test_admin_get_config() {
    run_test \
        "GET /api/v1/admin/1/ai-researcher/config" \
        "GET" \
        "/api/v1/admin/1/ai-researcher/config" \
        "" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

test_admin_update_config() {
    local config_data='{"admin_id": 1, "firehose_enabled": true, "bot_detection_enabled": true, "bot_detection_threshold": 0.7, "research_max_queries": 5}'

    run_test \
        "PUT /api/v1/admin/1/ai-researcher/config" \
        "PUT" \
        "/api/v1/admin/1/ai-researcher/config" \
        "$config_data" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

test_admin_bot_detection() {
    run_test \
        "GET /api/v1/admin/1/bot-detection" \
        "GET" \
        "/api/v1/admin/1/bot-detection?limit=50&threshold=0.5&flagged_only=false" \
        "" \
        "501" \
        "true" \
        "check_not_implemented_response"
}

################################################################################
# Error Handling Tests
################################################################################

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
                AI_RESEARCHER_URL="$2"
                shift 2
                ;;
            --api-key)
                API_KEY="$2"
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
    log_info "WaddleBot AI Researcher Core Module API Test Suite"
    log_info "======================================================================"
    log_info "AI Researcher URL: $AI_RESEARCHER_URL"
    log_info "API Key: ${API_KEY:+[SET]}${API_KEY:-[NOT SET]}"
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

    log_info "Running Research Endpoint Tests..."
    test_research
    test_ask
    test_recall
    test_summarize
    test_firehose
    test_stream_end
    test_get_context
    test_get_memory
    echo ""

    log_info "Running Admin API Tests..."
    test_admin_ai_insights
    test_admin_get_config
    test_admin_update_config
    test_admin_bot_detection
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
