#!/usr/bin/env bash
################################################################################
# WaddleBot Inventory Interaction Module API Test Script
################################################################################
#
# Comprehensive test suite for the Inventory Interaction Module API endpoints.
# Tests health checks, item CRUD operations, checkout/checkin workflows,
# searching, stock management, and audit logging.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set inventory module URL (default: http://localhost:8024)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   INVENTORY_URL       Base URL for inventory module (default: http://localhost:8024)
#   INVENTORY_API_KEY   API key for authenticated endpoints
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
INVENTORY_URL="${INVENTORY_URL:-http://localhost:8024}"
INVENTORY_API_KEY="${INVENTORY_API_KEY:-}"
VERBOSE="${VERBOSE:-false}"
SKIP_AUTH=false

# Test data storage
CREATED_ITEM_ID=""
CREATED_CHECKOUT_ID=""
COMMUNITY_ID=1

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

    local url="${INVENTORY_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$INVENTORY_API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${INVENTORY_API_KEY}")
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
    if [[ "$auth_required" == "true" ]] && [[ -z "$INVENTORY_API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
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

    return 0
}

check_status_response() {
    local response="$1"

    # Check for status field
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

    return 0
}

check_item_create_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.id' > /dev/null 2>&1; then
        log_error "Missing 'data.id' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.name' > /dev/null 2>&1; then
        log_error "Missing 'data.name' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.quantity' > /dev/null 2>&1; then
        log_error "Missing 'data.quantity' field"
        return 1
    fi

    # Store item ID for later tests
    CREATED_ITEM_ID=$(echo "$response" | jq -r '.data.id')
    log_verbose "Stored item ID: $CREATED_ITEM_ID"

    return 0
}

check_item_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.id' > /dev/null 2>&1; then
        log_error "Missing 'data.id' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.name' > /dev/null 2>&1; then
        log_error "Missing 'data.name' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.available_quantity' > /dev/null 2>&1; then
        log_error "Missing 'data.available_quantity' field"
        return 1
    fi

    return 0
}

check_items_list_response() {
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

check_search_response() {
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

check_checkout_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.id' > /dev/null 2>&1; then
        log_error "Missing 'data.id' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.status' > /dev/null 2>&1; then
        log_error "Missing 'data.status' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.status' | grep -q "active"; then
        log_error "Checkout not in active status"
        return 1
    fi

    # Store checkout ID for later tests
    CREATED_CHECKOUT_ID=$(echo "$response" | jq -r '.data.id')
    log_verbose "Stored checkout ID: $CREATED_CHECKOUT_ID"

    return 0
}

check_summary_response() {
    local response="$1"

    # Check for required fields
    if ! echo "$response" | jq -e '.data.total_items' > /dev/null 2>&1; then
        log_error "Missing 'data.total_items' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.total_quantity' > /dev/null 2>&1; then
        log_error "Missing 'data.total_quantity' field"
        return 1
    fi

    if ! echo "$response" | jq -e '.data.active_checkouts' > /dev/null 2>&1; then
        log_error "Missing 'data.active_checkouts' field"
        return 1
    fi

    return 0
}

check_checkouts_list_response() {
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

################################################################################
# Parse Arguments
################################################################################

while [[ $# -gt 0 ]]; do
    case $1 in
        --help)
            print_help
            exit 0
            ;;
        --url)
            INVENTORY_URL="$2"
            shift 2
            ;;
        --api-key)
            INVENTORY_API_KEY="$2"
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

################################################################################
# Test Cases - Health & Status
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
# Test Cases - Item Management
################################################################################

test_add_item() {
    local data='{
        "name": "Test Laptop",
        "description": "High-performance laptop for testing",
        "item_type": "equipment",
        "category": "electronics",
        "quantity": 3,
        "checkout_price": 50,
        "max_checkout_duration_hours": 72,
        "image_url": "https://example.com/laptop.jpg"
    }'

    run_test \
        "POST /api/v1/items (add item)" \
        "POST" \
        "/api/v1/items" \
        "$data" \
        "201" \
        "false" \
        "check_item_create_response"
}

test_get_item_by_id() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "GET /api/v1/items/{id} (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    run_test \
        "GET /api/v1/items/${CREATED_ITEM_ID}" \
        "GET" \
        "/api/v1/items/${CREATED_ITEM_ID}" \
        "" \
        "200" \
        "false" \
        "check_item_response"
}

test_update_item() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "PUT /api/v1/items/{id} (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{
        "name": "Updated Test Laptop",
        "checkout_price": 75
    }'

    run_test \
        "PUT /api/v1/items/${CREATED_ITEM_ID}" \
        "PUT" \
        "/api/v1/items/${CREATED_ITEM_ID}" \
        "$data" \
        "200" \
        "false" \
        "check_item_response"
}

test_get_available_items() {
    run_test \
        "GET /api/v1/items (list available)" \
        "GET" \
        "/api/v1/items?include_unavailable=false" \
        "" \
        "200" \
        "false" \
        "check_items_list_response"
}

test_search_items() {
    run_test \
        "GET /api/v1/items/search (search)" \
        "GET" \
        "/api/v1/items/search?q=laptop" \
        "" \
        "200" \
        "false" \
        "check_search_response"
}

################################################################################
# Test Cases - Checkout/Checkin
################################################################################

test_checkout_item() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "POST /api/v1/items/{id}/checkout (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{
        "user_id": 100,
        "quantity": 1,
        "checkout_duration_hours": 48,
        "notes": "Test checkout"
    }'

    run_test \
        "POST /api/v1/items/${CREATED_ITEM_ID}/checkout" \
        "POST" \
        "/api/v1/items/${CREATED_ITEM_ID}/checkout" \
        "$data" \
        "200" \
        "false" \
        "check_checkout_response"
}

test_checkin_item() {
    if [[ -z "$CREATED_CHECKOUT_ID" ]]; then
        log_skip "POST /api/v1/checkouts/{id}/checkin (no checkout ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{
        "returned_condition": "Good condition"
    }'

    run_test \
        "POST /api/v1/checkouts/${CREATED_CHECKOUT_ID}/checkin" \
        "POST" \
        "/api/v1/checkouts/${CREATED_CHECKOUT_ID}/checkin" \
        "$data" \
        "200" \
        "false"
}

test_list_checkouts() {
    run_test \
        "GET /api/v1/checkouts (list)" \
        "GET" \
        "/api/v1/checkouts?status=active" \
        "" \
        "200" \
        "false" \
        "check_checkouts_list_response"
}

test_get_user_checkouts() {
    run_test \
        "GET /api/v1/checkouts (user)" \
        "GET" \
        "/api/v1/checkouts?user_id=100" \
        "" \
        "200" \
        "false" \
        "check_checkouts_list_response"
}

################################################################################
# Test Cases - Stock Management
################################################################################

test_add_stock() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "POST /api/v1/items/{id}/add-stock (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{
        "quantity": 5,
        "reason": "Restocking"
    }'

    run_test \
        "POST /api/v1/items/${CREATED_ITEM_ID}/add-stock" \
        "POST" \
        "/api/v1/items/${CREATED_ITEM_ID}/add-stock" \
        "$data" \
        "200" \
        "false" \
        "check_item_response"
}

test_remove_stock() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "POST /api/v1/items/{id}/remove-stock (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{
        "quantity": 2,
        "reason": "Damaged items"
    }'

    run_test \
        "POST /api/v1/items/${CREATED_ITEM_ID}/remove-stock" \
        "POST" \
        "/api/v1/items/${CREATED_ITEM_ID}/remove-stock" \
        "$data" \
        "200" \
        "false" \
        "check_item_response"
}

################################################################################
# Test Cases - Inventory Summary
################################################################################

test_inventory_summary() {
    run_test \
        "GET /api/v1/summary" \
        "GET" \
        "/api/v1/summary" \
        "" \
        "200" \
        "false" \
        "check_summary_response"
}

test_low_stock_items() {
    run_test \
        "GET /api/v1/items/low-stock" \
        "GET" \
        "/api/v1/items/low-stock" \
        "" \
        "200" \
        "false" \
        "check_items_list_response"
}

test_overdue_checkouts() {
    run_test \
        "GET /api/v1/checkouts/overdue" \
        "GET" \
        "/api/v1/checkouts/overdue" \
        "" \
        "200" \
        "false" \
        "check_checkouts_list_response"
}

################################################################################
# Test Cases - Delete Item
################################################################################

test_delete_item() {
    if [[ -z "$CREATED_ITEM_ID" ]]; then
        log_skip "DELETE /api/v1/items/{id} (no item ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    run_test \
        "DELETE /api/v1/items/${CREATED_ITEM_ID}" \
        "DELETE" \
        "/api/v1/items/${CREATED_ITEM_ID}" \
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
    # Check requirements
    check_requirements

    # Print test configuration
    echo ""
    log_info "======================================================================"
    log_info "WaddleBot Inventory Interaction Module API Test Suite"
    log_info "======================================================================"
    log_info "Inventory Module URL: $INVENTORY_URL"
    log_info "API Key: ${INVENTORY_API_KEY:+[SET]}${INVENTORY_API_KEY:-[NOT SET]}"
    log_info "Verbose: $VERBOSE"
    log_info "Skip Auth Tests: $SKIP_AUTH"
    log_info "======================================================================"
    echo ""

    # Run tests
    log_info "Running Health & Status Tests..."
    test_health
    test_status
    echo ""

    log_info "Running Item Management Tests..."
    test_add_item
    test_get_item_by_id
    test_update_item
    test_get_available_items
    test_search_items
    echo ""

    log_info "Running Stock Management Tests..."
    test_add_stock
    test_remove_stock
    echo ""

    log_info "Running Checkout/Checkin Tests..."
    test_checkout_item
    test_list_checkouts
    test_get_user_checkouts
    test_checkin_item
    echo ""

    log_info "Running Inventory Summary Tests..."
    test_inventory_summary
    test_low_stock_items
    test_overdue_checkouts
    echo ""

    log_info "Running Error Handling Tests..."
    test_invalid_endpoint
    test_invalid_method
    echo ""

    log_info "Running Cleanup Tests..."
    test_delete_item
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
