#!/usr/bin/env bash
#
# Labels Core Module API Test Script
# Comprehensive test suite for all Labels Core Module endpoints
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set base URL (default: http://localhost:8023)
#   --verbose           Enable verbose output
#   --no-color          Disable colored output
#
# Environment Variables:
#   LABELS_URL          Base URL for the Labels module (default: http://localhost:8023)
#

set -o pipefail

# ============================================================================
# Configuration and Setup
# ============================================================================

# Default configuration
BASE_URL="${LABELS_URL:-http://localhost:8023}"
VERBOSE=0
USE_COLOR=1

# Color codes
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
    RED=$(tput setaf 1)
    GREEN=$(tput setaf 2)
    YELLOW=$(tput setaf 3)
    BLUE=$(tput setaf 4)
    MAGENTA=$(tput setaf 5)
    CYAN=$(tput setaf 6)
    BOLD=$(tput bold)
    RESET=$(tput sgr0)
else
    RED=""
    GREEN=""
    YELLOW=""
    BLUE=""
    MAGENTA=""
    CYAN=""
    BOLD=""
    RESET=""
fi

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Test data storage
CREATED_LABEL_ID=""
TEST_ENTITY_ID="test_entity_$(date +%s)"
TEST_USER="test_user"

# ============================================================================
# Helper Functions
# ============================================================================

disable_colors() {
    RED=""
    GREEN=""
    YELLOW=""
    BLUE=""
    MAGENTA=""
    CYAN=""
    BOLD=""
    RESET=""
}

show_help() {
    cat << EOF
${BOLD}Labels Core Module API Test Script${RESET}

${BOLD}USAGE:${RESET}
    $0 [OPTIONS]

${BOLD}OPTIONS:${RESET}
    --help              Show this help message
    --url URL           Set base URL (default: http://localhost:8023)
    --verbose           Enable verbose output
    --no-color          Disable colored output

${BOLD}ENVIRONMENT VARIABLES:${RESET}
    LABELS_URL          Base URL for the Labels module (default: http://localhost:8023)

${BOLD}EXAMPLES:${RESET}
    # Run tests against local instance
    $0

    # Run tests against custom URL
    $0 --url http://labels-service:8023

    # Run with verbose output
    $0 --verbose

    # Run without colors (for CI/CD)
    $0 --no-color

${BOLD}EXIT CODES:${RESET}
    0    All tests passed
    1    One or more tests failed

EOF
}

log_info() {
    echo "${BLUE}[INFO]${RESET} $*"
}

log_success() {
    echo "${GREEN}[PASS]${RESET} $*"
}

log_error() {
    echo "${RED}[FAIL]${RESET} $*"
}

log_skip() {
    echo "${YELLOW}[SKIP]${RESET} $*"
}

log_verbose() {
    if [[ $VERBOSE -eq 1 ]]; then
        echo "${CYAN}[DEBUG]${RESET} $*"
    fi
}

log_section() {
    echo ""
    echo "${BOLD}${MAGENTA}=== $* ===${RESET}"
    echo ""
}

# Check if required commands are available
check_dependencies() {
    local missing_deps=()

    for cmd in curl jq; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing_deps+=("$cmd")
        fi
    done

    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing_deps[*]}"
        log_info "Please install missing dependencies and try again"
        exit 1
    fi
}

# Make HTTP request and return response
http_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    local expected_status="${4:-200}"

    local url="${BASE_URL}${endpoint}"
    local response
    local http_code
    local curl_exit_code

    log_verbose "Request: $method $url"
    if [[ -n "$data" ]]; then
        log_verbose "Data: $data"
    fi

    if [[ -n "$data" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$url" 2>&1)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            "$url" 2>&1)
    fi
    curl_exit_code=$?

    if [[ $curl_exit_code -ne 0 ]]; then
        log_verbose "Curl failed with exit code: $curl_exit_code"
        echo ""
        return 1
    fi

    http_code=$(echo "$response" | tail -n1)
    response=$(echo "$response" | sed '$d')

    log_verbose "Response code: $http_code"
    log_verbose "Response body: $response"

    if [[ "$http_code" != "$expected_status" ]]; then
        log_verbose "Expected status $expected_status but got $http_code"
        echo "$response"
        return 1
    fi

    echo "$response"
    return 0
}

# Test wrapper function
run_test() {
    local test_name="$1"
    local test_func="$2"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    log_info "Running: $test_name"

    if $test_func; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        log_success "$test_name"
        return 0
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        log_error "$test_name"
        return 1
    fi
}

skip_test() {
    local test_name="$1"
    local reason="$2"

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    SKIPPED_TESTS=$((SKIPPED_TESTS + 1))

    log_skip "$test_name - Reason: $reason"
}

# ============================================================================
# Test Functions
# ============================================================================

test_health_check() {
    local response
    response=$(http_request GET "/health" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response contains expected fields
    echo "$response" | jq -e '.status' >/dev/null 2>&1 || return 1

    local status
    status=$(echo "$response" | jq -r '.status')
    [[ "$status" == "healthy" ]] || return 1

    return 0
}

test_ready_check() {
    local response
    response=$(http_request GET "/ready" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response contains expected fields
    echo "$response" | jq -e '.status' >/dev/null 2>&1 || return 1

    return 0
}

test_metrics_check() {
    local response
    response=$(http_request GET "/metrics" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response contains expected fields
    echo "$response" | jq -e '.module' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.version' >/dev/null 2>&1 || return 1

    return 0
}

test_status_endpoint() {
    local response
    response=$(http_request GET "/api/v1/status" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response structure
    echo "$response" | jq -e '.data.status' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.module' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.version' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.supported_entity_types' >/dev/null 2>&1 || return 1

    return 0
}

test_list_labels_empty() {
    local response
    response=$(http_request GET "/api/v1/labels" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response structure
    echo "$response" | jq -e '.data.labels' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.total' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.supported_types' >/dev/null 2>&1 || return 1

    return 0
}

test_create_label() {
    local data='{"name":"TestLabel","category":"user","description":"Test label for API tests","color":"#ff0000","created_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels" "$data" 201)
    [[ $? -eq 0 ]] || return 1

    # Extract label ID for future tests
    CREATED_LABEL_ID=$(echo "$response" | jq -r '.data.label_id')
    log_verbose "Created label ID: $CREATED_LABEL_ID"

    [[ -n "$CREATED_LABEL_ID" ]] && [[ "$CREATED_LABEL_ID" != "null" ]] || return 1

    return 0
}

test_create_label_missing_fields() {
    local data='{"name":"TestLabel"}'
    local response
    response=$(http_request POST "/api/v1/labels" "$data" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_create_label_invalid_category() {
    local data='{"name":"InvalidLabel","category":"invalid_type","created_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels" "$data" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_create_duplicate_label() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"name":"TestLabel","category":"user","created_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels" "$data" 409)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_get_label() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local response
    response=$(http_request GET "/api/v1/labels/$CREATED_LABEL_ID" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify label details
    echo "$response" | jq -e '.data.label.id' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.label.name' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.label.category' >/dev/null 2>&1 || return 1

    local name
    name=$(echo "$response" | jq -r '.data.label.name')
    [[ "$name" == "TestLabel" ]] || return 1

    return 0
}

test_get_nonexistent_label() {
    local response
    response=$(http_request GET "/api/v1/labels/999999" "" 404)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_update_label() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"name":"UpdatedTestLabel","description":"Updated description","color":"#00ff00"}'
    local response
    response=$(http_request PUT "/api/v1/labels/$CREATED_LABEL_ID" "$data" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify the update
    response=$(http_request GET "/api/v1/labels/$CREATED_LABEL_ID" "" 200)
    [[ $? -eq 0 ]] || return 1

    local name
    name=$(echo "$response" | jq -r '.data.label.name')
    [[ "$name" == "UpdatedTestLabel" ]] || return 1

    return 0
}

test_list_labels_with_filter() {
    local response
    response=$(http_request GET "/api/v1/labels?category=user" "" 200)
    [[ $? -eq 0 ]] || return 1

    echo "$response" | jq -e '.data.labels' >/dev/null 2>&1 || return 1

    return 0
}

test_list_labels_with_search() {
    local response
    response=$(http_request GET "/api/v1/labels?search=Updated" "" 200)
    [[ $? -eq 0 ]] || return 1

    echo "$response" | jq -e '.data.labels' >/dev/null 2>&1 || return 1

    return 0
}

test_apply_label_to_entity() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"user","label_id":'$CREATED_LABEL_ID',"applied_by":"'$TEST_USER'","community_id":"test_community"}'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 201)
    [[ $? -eq 0 ]] || return 1

    echo "$response" | jq -e '.data.entity_label_id' >/dev/null 2>&1 || return 1

    return 0
}

test_apply_label_missing_fields() {
    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"user"}'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_apply_label_invalid_entity_type() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"invalid_type","label_id":'$CREATED_LABEL_ID',"applied_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_apply_label_nonexistent_label() {
    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"user","label_id":999999,"applied_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 404)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_apply_duplicate_label() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"user","label_id":'$CREATED_LABEL_ID',"applied_by":"'$TEST_USER'"}'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 409)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_get_entity_labels() {
    local response
    response=$(http_request GET "/api/v1/entity/user/$TEST_ENTITY_ID/labels" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response structure
    echo "$response" | jq -e '.data.entity_id' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.entity_type' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.labels' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.total' >/dev/null 2>&1 || return 1

    # Verify we have at least one label
    local total
    total=$(echo "$response" | jq -r '.data.total')
    [[ "$total" -gt 0 ]] || return 1

    return 0
}

test_get_entity_labels_invalid_type() {
    local response
    response=$(http_request GET "/api/v1/entity/invalid_type/$TEST_ENTITY_ID/labels" "" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_search_by_labels() {
    local response
    response=$(http_request GET "/api/v1/labels/search?entity_type=user&labels=UpdatedTestLabel" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify response structure
    echo "$response" | jq -e '.data.entity_type' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.searched_labels' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.results' >/dev/null 2>&1 || return 1

    return 0
}

test_search_by_labels_missing_params() {
    local response
    response=$(http_request GET "/api/v1/labels/search?entity_type=user" "" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_search_by_labels_invalid_type() {
    local response
    response=$(http_request GET "/api/v1/labels/search?entity_type=invalid&labels=test" "" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_search_by_multiple_labels() {
    local response
    response=$(http_request GET "/api/v1/labels/search?entity_type=user&labels=UpdatedTestLabel,AnotherLabel" "" 200)
    [[ $? -eq 0 ]] || return 1

    echo "$response" | jq -e '.data.results' >/dev/null 2>&1 || return 1

    return 0
}

test_search_by_labels_match_all() {
    local response
    response=$(http_request GET "/api/v1/labels/search?entity_type=user&labels=UpdatedTestLabel&match_all=true" "" 200)
    [[ $? -eq 0 ]] || return 1

    echo "$response" | jq -e '.data.match_all' >/dev/null 2>&1 || return 1

    return 0
}

test_apply_labels_bulk() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local entity1="bulk_test_1_$(date +%s)"
    local entity2="bulk_test_2_$(date +%s)"
    local data='[
        {"entity_id":"'$entity1'","entity_type":"item","label_id":'$CREATED_LABEL_ID',"applied_by":"'$TEST_USER'"},
        {"entity_id":"'$entity2'","entity_type":"item","label_id":'$CREATED_LABEL_ID',"applied_by":"'$TEST_USER'"}
    ]'
    local response
    response=$(http_request POST "/api/v1/labels/apply" "$data" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify bulk response
    echo "$response" | jq -e '.data.results' >/dev/null 2>&1 || return 1
    echo "$response" | jq -e '.data.summary' >/dev/null 2>&1 || return 1

    local successful
    successful=$(echo "$response" | jq -r '.data.summary.successful')
    [[ "$successful" -eq 2 ]] || return 1

    return 0
}

test_remove_label_from_entity() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"entity_id":"'$TEST_ENTITY_ID'","entity_type":"user","label_id":'$CREATED_LABEL_ID'}'
    local response
    response=$(http_request POST "/api/v1/labels/remove" "$data" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify the label was removed
    response=$(http_request GET "/api/v1/entity/user/$TEST_ENTITY_ID/labels" "" 200)
    [[ $? -eq 0 ]] || return 1

    local total
    total=$(echo "$response" | jq -r '.data.total')
    [[ "$total" -eq 0 ]] || return 1

    return 0
}

test_remove_label_missing_fields() {
    local data='{"entity_id":"'$TEST_ENTITY_ID'"}'
    local response
    response=$(http_request POST "/api/v1/labels/remove" "$data" 400)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_remove_nonexistent_label_assignment() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local data='{"entity_id":"nonexistent_entity","entity_type":"user","label_id":'$CREATED_LABEL_ID'}'
    local response
    response=$(http_request POST "/api/v1/labels/remove" "$data" 404)
    [[ $? -eq 0 ]] || return 1

    return 0
}

test_delete_label() {
    if [[ -z "$CREATED_LABEL_ID" ]]; then
        return 1
    fi

    local response
    response=$(http_request DELETE "/api/v1/labels/$CREATED_LABEL_ID" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Verify the label is deleted (should return 404)
    response=$(http_request GET "/api/v1/labels/$CREATED_LABEL_ID" "" 200)
    [[ $? -eq 0 ]] || return 1

    # Check that is_active is false
    local is_active
    is_active=$(echo "$response" | jq -r '.data.label.is_active')
    [[ "$is_active" == "false" ]] || return 1

    return 0
}

test_delete_nonexistent_label() {
    local response
    response=$(http_request DELETE "/api/v1/labels/999999" "" 404)
    [[ $? -eq 0 ]] || return 1

    return 0
}

# ============================================================================
# Main Test Runner
# ============================================================================

run_all_tests() {
    log_section "Health & Status Checks"
    run_test "Health check endpoint" test_health_check
    run_test "Ready check endpoint" test_ready_check
    run_test "Metrics endpoint" test_metrics_check
    run_test "Status endpoint" test_status_endpoint

    log_section "Label Management - List"
    run_test "List labels (initial)" test_list_labels_empty

    log_section "Label Management - Create"
    run_test "Create label" test_create_label
    run_test "Create label - missing fields" test_create_label_missing_fields
    run_test "Create label - invalid category" test_create_label_invalid_category
    run_test "Create duplicate label" test_create_duplicate_label

    log_section "Label Management - Get"
    run_test "Get label by ID" test_get_label
    run_test "Get nonexistent label" test_get_nonexistent_label

    log_section "Label Management - Update"
    run_test "Update label" test_update_label

    log_section "Label Management - List with Filters"
    run_test "List labels with category filter" test_list_labels_with_filter
    run_test "List labels with search" test_list_labels_with_search

    log_section "Entity Label Assignment - Apply"
    run_test "Apply label to entity" test_apply_label_to_entity
    run_test "Apply label - missing fields" test_apply_label_missing_fields
    run_test "Apply label - invalid entity type" test_apply_label_invalid_entity_type
    run_test "Apply label - nonexistent label" test_apply_label_nonexistent_label
    run_test "Apply duplicate label" test_apply_duplicate_label
    run_test "Apply labels in bulk" test_apply_labels_bulk

    log_section "Entity Label Assignment - Get"
    run_test "Get entity labels" test_get_entity_labels
    run_test "Get entity labels - invalid type" test_get_entity_labels_invalid_type

    log_section "Entity Label Assignment - Search"
    run_test "Search by labels" test_search_by_labels
    run_test "Search by labels - missing params" test_search_by_labels_missing_params
    run_test "Search by labels - invalid type" test_search_by_labels_invalid_type
    run_test "Search by multiple labels" test_search_by_multiple_labels
    run_test "Search by labels - match all" test_search_by_labels_match_all

    log_section "Entity Label Assignment - Remove"
    run_test "Remove label from entity" test_remove_label_from_entity
    run_test "Remove label - missing fields" test_remove_label_missing_fields
    run_test "Remove nonexistent label assignment" test_remove_nonexistent_label_assignment

    log_section "Label Management - Delete"
    run_test "Delete label" test_delete_label
    run_test "Delete nonexistent label" test_delete_nonexistent_label
}

print_summary() {
    echo ""
    echo "${BOLD}========================================${RESET}"
    echo "${BOLD}           Test Summary${RESET}"
    echo "${BOLD}========================================${RESET}"
    echo ""
    echo "  Total Tests:    ${BOLD}$TOTAL_TESTS${RESET}"
    echo "  ${GREEN}Passed:         $PASSED_TESTS${RESET}"
    echo "  ${RED}Failed:         $FAILED_TESTS${RESET}"
    echo "  ${YELLOW}Skipped:        $SKIPPED_TESTS${RESET}"
    echo ""

    if [[ $FAILED_TESTS -eq 0 ]] && [[ $PASSED_TESTS -gt 0 ]]; then
        echo "${GREEN}${BOLD}✓ All tests passed!${RESET}"
        echo ""
        return 0
    elif [[ $TOTAL_TESTS -eq 0 ]]; then
        echo "${YELLOW}${BOLD}⚠ No tests were run${RESET}"
        echo ""
        return 1
    else
        echo "${RED}${BOLD}✗ Some tests failed${RESET}"
        echo ""
        return 1
    fi
}

# ============================================================================
# Argument Parsing
# ============================================================================

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --help|-h)
                show_help
                exit 0
                ;;
            --url)
                BASE_URL="$2"
                shift 2
                ;;
            --verbose|-v)
                VERBOSE=1
                shift
                ;;
            --no-color)
                disable_colors
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                echo ""
                show_help
                exit 1
                ;;
        esac
    done
}

# ============================================================================
# Main Execution
# ============================================================================

main() {
    parse_arguments "$@"

    # Print banner
    echo ""
    echo "${BOLD}${CYAN}========================================${RESET}"
    echo "${BOLD}${CYAN}  Labels Core Module API Test Suite${RESET}"
    echo "${BOLD}${CYAN}========================================${RESET}"
    echo ""
    echo "Base URL: ${BOLD}$BASE_URL${RESET}"
    echo "Verbose:  ${BOLD}$VERBOSE${RESET}"
    echo ""

    # Check dependencies
    check_dependencies

    # Check if service is reachable
    log_info "Checking if service is reachable..."
    if ! curl -s -f -o /dev/null --max-time 5 "$BASE_URL/health" 2>/dev/null; then
        log_error "Service is not reachable at $BASE_URL"
        log_info "Please ensure the service is running and the URL is correct"
        exit 1
    fi
    log_success "Service is reachable"
    echo ""

    # Run all tests
    run_all_tests

    # Print summary and exit
    print_summary
    exit $?
}

# Run main function
main "$@"
