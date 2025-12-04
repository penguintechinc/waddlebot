#!/usr/bin/env bash
################################################################################
# WaddleBot Memories Interaction Module API Test Script
################################################################################
#
# Comprehensive test suite for the Memories Interaction Module API endpoints.
# Tests health checks, memory management (quotes, URLs, notes), reminders, etc.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set Memories module URL (default: http://localhost:8031)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   MEMORIES_URL        Base URL for Memories module (default: http://localhost:8031)
#   MEMORIES_API_KEY    API key for authenticated endpoints
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
MEMORIES_URL="${MEMORIES_URL:-http://localhost:8031}"
MEMORIES_API_KEY="${MEMORIES_API_KEY:-}"
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

    local url="${MEMORIES_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$MEMORIES_API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${MEMORIES_API_KEY}")
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
    if [[ "$auth_required" == "true" ]] && [[ -z "$MEMORIES_API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
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

    # Check if response is valid JSON (unless it's empty)
    if [[ -n "$response" ]] && [[ "$response" != "null" ]]; then
        if ! echo "$response" | jq . > /dev/null 2>&1; then
            log_error "$test_name - Invalid JSON response"
            ((TESTS_FAILED++))
            return 1
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
    if ! echo "$response" | jq -e '.data.status' > /dev/null 2>&1; then
        log_error "Missing 'status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.data.status')

    if [[ "$status" != "healthy" ]]; then
        log_error "Service not healthy: $status"
        return 1
    fi

    return 0
}

check_status_response() {
    local response="$1"

    # Check for status field
    if ! echo "$response" | jq -e '.data.status' > /dev/null 2>&1; then
        log_error "Missing 'status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.data.status')

    if [[ "$status" != "operational" ]]; then
        log_error "Service not operational: $status"
        return 1
    fi

    # Check for module name
    if ! echo "$response" | jq -e '.data.module' > /dev/null 2>&1; then
        log_error "Missing 'module' field"
        return 1
    fi

    return 0
}

check_memories_list_response() {
    local response="$1"

    # Check for data array
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check if data is an array
    if ! echo "$response" | jq -e '.data | type == "array"' > /dev/null 2>&1; then
        log_error "'data' field should be an array"
        return 1
    fi

    return 0
}

check_memory_create_response() {
    local response="$1"

    # Check for required fields in created memory
    if ! echo "$response" | jq -e '.data.id' > /dev/null 2>&1; then
        log_error "Missing 'id' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.memory_type' > /dev/null 2>&1; then
        log_error "Missing 'memory_type' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.content' > /dev/null 2>&1; then
        log_error "Missing 'content' field"
        return 1
    fi

    return 0
}

check_reminders_list_response() {
    local response="$1"

    # Check for data array
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check if data is an array
    if ! echo "$response" | jq -e '.data | type == "array"' > /dev/null 2>&1; then
        log_error "'data' field should be an array"
        return 1
    fi

    return 0
}

check_reminder_create_response() {
    local response="$1"

    # Check for required fields in created reminder
    if ! echo "$response" | jq -e '.data.id' > /dev/null 2>&1; then
        log_error "Missing 'id' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.message' > /dev/null 2>&1; then
        log_error "Missing 'message' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.remind_at' > /dev/null 2>&1; then
        log_error "Missing 'remind_at' field"
        return 1
    fi

    return 0
}

check_search_response() {
    local response="$1"

    # Check for data array
    if ! echo "$response" | jq -e '.data.results' > /dev/null 2>&1; then
        log_error "Missing 'results' field"
        return 1
    fi

    # Check if results is an array
    if ! echo "$response" | jq -e '.data.results | type == "array"' > /dev/null 2>&1; then
        log_error "'results' field should be an array"
        return 1
    fi

    return 0
}

################################################################################
# Test Cases - Health & Info
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

test_ready() {
    run_test \
        "GET /ready" \
        "GET" \
        "/ready" \
        "" \
        "200" \
        "false" \
        "check_health_response"
}

test_metrics() {
    run_test \
        "GET /metrics" \
        "GET" \
        "/metrics" \
        "" \
        "200" \
        "false"
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
# Test Cases - Memories Management
################################################################################

test_memories_list() {
    run_test \
        "GET /api/v1/memories (list)" \
        "GET" \
        "/api/v1/memories?community_id=test-community" \
        "" \
        "200" \
        "false" \
        "check_memories_list_response"
}

test_memories_list_by_type() {
    run_test \
        "GET /api/v1/memories (by type)" \
        "GET" \
        "/api/v1/memories?community_id=test-community&memory_type=quote" \
        "" \
        "200" \
        "false" \
        "check_memories_list_response"
}

test_memory_create_quote() {
    local data='{
        "community_id": "test-community",
        "memory_type": "quote",
        "content": "This is a test quote",
        "attributed_to": "test_user",
        "created_by": "admin_user"
    }'

    run_test \
        "POST /api/v1/memories (create quote)" \
        "POST" \
        "/api/v1/memories" \
        "$data" \
        "201" \
        "true" \
        "check_memory_create_response"
}

test_memory_create_url() {
    local data='{
        "community_id": "test-community",
        "memory_type": "url",
        "content": "https://example.com",
        "title": "Example Link",
        "description": "A test URL",
        "created_by": "admin_user"
    }'

    run_test \
        "POST /api/v1/memories (create URL)" \
        "POST" \
        "/api/v1/memories" \
        "$data" \
        "201" \
        "true" \
        "check_memory_create_response"
}

test_memory_create_note() {
    local data='{
        "community_id": "test-community",
        "memory_type": "note",
        "content": "This is a community note",
        "title": "Test Note",
        "created_by": "admin_user"
    }'

    run_test \
        "POST /api/v1/memories (create note)" \
        "POST" \
        "/api/v1/memories" \
        "$data" \
        "201" \
        "true" \
        "check_memory_create_response"
}

test_memory_create_missing_type() {
    local data='{
        "community_id": "test-community",
        "content": "Content without type"
    }'

    run_test \
        "POST /api/v1/memories (missing type)" \
        "POST" \
        "/api/v1/memories" \
        "$data" \
        "400" \
        "true"
}

test_memory_get() {
    run_test \
        "GET /api/v1/memories/:id" \
        "GET" \
        "/api/v1/memories/test-memory-id" \
        "" \
        "200" \
        "false"
}

test_memory_update() {
    local data='{
        "content": "Updated content",
        "title": "Updated Title"
    }'

    run_test \
        "PUT /api/v1/memories/:id" \
        "PUT" \
        "/api/v1/memories/test-memory-id" \
        "$data" \
        "200" \
        "true"
}

test_memory_delete() {
    run_test \
        "DELETE /api/v1/memories/:id" \
        "DELETE" \
        "/api/v1/memories/test-memory-id" \
        "" \
        "200" \
        "true"
}

################################################################################
# Test Cases - Reminders
################################################################################

test_reminders_list() {
    run_test \
        "GET /api/v1/reminders (list)" \
        "GET" \
        "/api/v1/reminders?user_id=test-user" \
        "" \
        "200" \
        "false" \
        "check_reminders_list_response"
}

test_reminder_create() {
    local data='{
        "user_id": "test-user",
        "message": "Remember to check the logs",
        "remind_at": "2025-12-05T10:00:00Z"
    }'

    run_test \
        "POST /api/v1/reminders (create)" \
        "POST" \
        "/api/v1/reminders" \
        "$data" \
        "201" \
        "true" \
        "check_reminder_create_response"
}

test_reminder_create_natural_language() {
    local data='{
        "user_id": "test-user",
        "message": "Water the plants",
        "remind_in": "2 hours"
    }'

    run_test \
        "POST /api/v1/reminders (natural language)" \
        "POST" \
        "/api/v1/reminders" \
        "$data" \
        "201" \
        "true" \
        "check_reminder_create_response"
}

test_reminder_delete() {
    run_test \
        "DELETE /api/v1/reminders/:id" \
        "DELETE" \
        "/api/v1/reminders/test-reminder-id" \
        "" \
        "200" \
        "true"
}

################################################################################
# Test Cases - Search
################################################################################

test_search_memories() {
    run_test \
        "GET /api/v1/memories/search" \
        "GET" \
        "/api/v1/memories/search?q=test&community_id=test-community" \
        "" \
        "200" \
        "false" \
        "check_search_response"
}

test_search_memories_by_tag() {
    run_test \
        "GET /api/v1/memories/search (by tag)" \
        "GET" \
        "/api/v1/memories/search?tag=important&community_id=test-community" \
        "" \
        "200" \
        "false" \
        "check_search_response"
}

################################################################################
# Test Cases - Statistics
################################################################################

test_memory_stats() {
    run_test \
        "GET /api/v1/memories/stats" \
        "GET" \
        "/api/v1/memories/stats?community_id=test-community" \
        "" \
        "200" \
        "false"
}

test_user_memory_stats() {
    run_test \
        "GET /api/v1/memories/stats/user" \
        "GET" \
        "/api/v1/memories/stats/user?user_id=test-user&community_id=test-community" \
        "" \
        "200" \
        "false"
}

################################################################################
# Test Cases - Error Handling
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
        "PATCH /api/v1/status (invalid method)" \
        "PATCH" \
        "/api/v1/status" \
        "" \
        "405" \
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
                MEMORIES_URL="$2"
                shift 2
                ;;
            --api-key)
                MEMORIES_API_KEY="$2"
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
    log_info "WaddleBot Memories Interaction Module API Test Suite"
    log_info "======================================================================"
    log_info "Memories Module URL: $MEMORIES_URL"
    log_info "API Key: ${MEMORIES_API_KEY:+[SET]}${MEMORIES_API_KEY:-[NOT SET]}"
    log_info "Verbose: $VERBOSE"
    log_info "Skip Auth Tests: $SKIP_AUTH"
    log_info "======================================================================"
    echo ""

    # Run tests
    log_info "Running Health & Info Tests..."
    test_health
    test_ready
    test_metrics
    test_status
    echo ""

    log_info "Running Memories Management Tests..."
    test_memories_list
    test_memories_list_by_type
    test_memory_create_quote
    test_memory_create_url
    test_memory_create_note
    test_memory_create_missing_type
    test_memory_get
    test_memory_update
    test_memory_delete
    echo ""

    log_info "Running Reminders Tests..."
    test_reminders_list
    test_reminder_create
    test_reminder_create_natural_language
    test_reminder_delete
    echo ""

    log_info "Running Search Tests..."
    test_search_memories
    test_search_memories_by_tag
    echo ""

    log_info "Running Statistics Tests..."
    test_memory_stats
    test_user_memory_stats
    echo ""

    log_info "Running Error Handling Tests..."
    test_invalid_endpoint
    test_invalid_method
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
