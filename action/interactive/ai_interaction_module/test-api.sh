#!/usr/bin/env bash
################################################################################
# WaddleBot AI Interaction Module API Test Script
################################################################################
#
# Comprehensive test suite for the AI Interaction Module API endpoints.
# Tests health checks, AI interactions, chat completions, models, config, etc.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set AI module URL (default: http://localhost:8005)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   AI_URL              Base URL for AI module (default: http://localhost:8005)
#   AI_API_KEY          API key for authenticated endpoints
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
AI_URL="${AI_URL:-http://localhost:8005}"
AI_API_KEY="${AI_API_KEY:-}"
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

    local url="${AI_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$AI_API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${AI_API_KEY}")
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
    if [[ "$auth_required" == "true" ]] && [[ -z "$AI_API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
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

check_index_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.module' > /dev/null 2>&1; then
        log_error "Missing 'module' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.version' > /dev/null 2>&1; then
        log_error "Missing 'version' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.endpoints' > /dev/null 2>&1; then
        log_error "Missing 'endpoints' field"
        return 1
    fi

    return 0
}

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

check_models_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.provider' > /dev/null 2>&1; then
        log_error "Missing 'provider' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.models' > /dev/null 2>&1; then
        log_error "Missing 'models' field"
        return 1
    fi

    return 0
}

check_config_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.provider' > /dev/null 2>&1; then
        log_error "Missing 'provider' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.model' > /dev/null 2>&1; then
        log_error "Missing 'model' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.temperature' > /dev/null 2>&1; then
        log_error "Missing 'temperature' field"
        return 1
    fi

    return 0
}

check_interaction_response() {
    local response="$1"

    # Check for session_id field
    if ! echo "$response" | jq -e '.data.session_id' > /dev/null 2>&1; then
        log_error "Missing 'session_id' field"
        return 1
    fi

    return 0
}

check_chat_completions_response() {
    local response="$1"

    # Check OpenAI-compatible format
    if ! echo "$response" | jq -e '.data.choices' > /dev/null 2>&1; then
        log_error "Missing 'choices' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.choices[0].message.content' > /dev/null 2>&1; then
        log_error "Missing message content"
        return 1
    fi

    return 0
}

check_test_response() {
    local response="$1"

    # Check for input/output fields
    if ! echo "$response" | jq -e '.data.input' > /dev/null 2>&1; then
        log_error "Missing 'input' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.output' > /dev/null 2>&1; then
        log_error "Missing 'output' field"
        return 1
    fi

    return 0
}

################################################################################
# Test Cases
################################################################################

test_index() {
    run_test \
        "GET /" \
        "GET" \
        "/" \
        "" \
        "200" \
        "false" \
        "check_index_response"
}

test_index_explicit() {
    run_test \
        "GET /index" \
        "GET" \
        "/index" \
        "" \
        "200" \
        "false" \
        "check_index_response"
}

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

test_interaction_no_session_id() {
    run_test \
        "POST /api/v1/ai/interaction (no session_id)" \
        "POST" \
        "/api/v1/ai/interaction" \
        '{"message_content":"Hello"}' \
        "400" \
        "false"
}

test_interaction_valid() {
    local data='{
        "session_id": "test-session-123",
        "message_type": "chatMessage",
        "message_content": "Hello, how are you?",
        "user_id": "user123",
        "entity_id": "test:channel:456",
        "platform": "test",
        "username": "test_user",
        "display_name": "Test User"
    }'

    run_test \
        "POST /api/v1/ai/interaction (valid)" \
        "POST" \
        "/api/v1/ai/interaction" \
        "$data" \
        "200" \
        "false" \
        "check_interaction_response"
}

test_models() {
    run_test \
        "GET /api/v1/ai/models" \
        "GET" \
        "/api/v1/ai/models" \
        "" \
        "200" \
        "false" \
        "check_models_response"
}

test_config_get() {
    run_test \
        "GET /api/v1/ai/config" \
        "GET" \
        "/api/v1/ai/config" \
        "" \
        "200" \
        "true" \
        "check_config_response"
}

test_config_put() {
    local data='{
        "temperature": 0.8,
        "max_tokens": 600
    }'

    run_test \
        "PUT /api/v1/ai/config" \
        "PUT" \
        "/api/v1/ai/config" \
        "$data" \
        "200" \
        "true"
}

test_chat_completions_no_messages() {
    run_test \
        "POST /api/v1/ai/chat/completions (no messages)" \
        "POST" \
        "/api/v1/ai/chat/completions" \
        '{"model":"test"}' \
        "400" \
        "true"
}

test_chat_completions_valid() {
    local data='{
        "model": "llama3.2",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is the capital of France?"}
        ],
        "temperature": 0.7,
        "max_tokens": 100
    }'

    run_test \
        "POST /api/v1/ai/chat/completions (valid)" \
        "POST" \
        "/api/v1/ai/chat/completions" \
        "$data" \
        "200" \
        "true" \
        "check_chat_completions_response"
}

test_test_endpoint() {
    local data='{
        "message": "Test message for AI"
    }'

    run_test \
        "POST /api/v1/ai/test" \
        "POST" \
        "/api/v1/ai/test" \
        "$data" \
        "200" \
        "true" \
        "check_test_response"
}

test_test_endpoint_default() {
    run_test \
        "POST /api/v1/ai/test (default message)" \
        "POST" \
        "/api/v1/ai/test" \
        '{}' \
        "200" \
        "true" \
        "check_test_response"
}

test_invalid_endpoint() {
    run_test \
        "GET /api/v1/ai/nonexistent" \
        "GET" \
        "/api/v1/ai/nonexistent" \
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
                AI_URL="$2"
                shift 2
                ;;
            --api-key)
                AI_API_KEY="$2"
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
    log_info "WaddleBot AI Interaction Module API Test Suite"
    log_info "======================================================================"
    log_info "AI Module URL: $AI_URL"
    log_info "API Key: ${AI_API_KEY:+[SET]}${AI_API_KEY:-[NOT SET]}"
    log_info "Verbose: $VERBOSE"
    log_info "Skip Auth Tests: $SKIP_AUTH"
    log_info "======================================================================"
    echo ""

    # Run tests
    log_info "Running Health & Info Tests..."
    test_index
    test_index_explicit
    test_health
    test_ready
    test_metrics
    echo ""

    log_info "Running Interaction Tests..."
    test_interaction_no_session_id
    test_interaction_valid
    echo ""

    log_info "Running Models Tests..."
    test_models
    echo ""

    log_info "Running Config Tests..."
    test_config_get
    test_config_put
    echo ""

    log_info "Running Chat Completions Tests..."
    test_chat_completions_no_messages
    test_chat_completions_valid
    echo ""

    log_info "Running Test Endpoint Tests..."
    test_test_endpoint
    test_test_endpoint_default
    echo ""

    log_info "Running Error Handling Tests..."
    test_invalid_endpoint
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
