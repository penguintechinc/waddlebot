#!/usr/bin/env bash
################################################################################
# WaddleBot Loyalty Interaction Module API Test Script
################################################################################
#
# Comprehensive test suite for the Loyalty Interaction Module API endpoints.
# Tests currency management, earning config, giveaways, minigames, duels, and gear.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help              Show this help message
#   --url URL           Set loyalty module URL (default: http://localhost:8032)
#   --api-key KEY       Set API key for authenticated endpoints
#   --verbose           Enable verbose output
#   --skip-auth         Skip tests requiring authentication
#
# Environment Variables:
#   LOYALTY_URL         Base URL for loyalty module (default: http://localhost:8032)
#   LOYALTY_API_KEY     API key for authenticated endpoints
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
LOYALTY_URL="${LOYALTY_URL:-http://localhost:8032}"
LOYALTY_API_KEY="${LOYALTY_API_KEY:-}"
VERBOSE="${VERBOSE:-false}"
SKIP_AUTH=false

# Test data storage
GIVEAWAY_ID=""
DUEL_ID=""

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

    local url="${LOYALTY_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

    # Add API key header if required and available
    if [[ "$auth_required" == "true" ]] && [[ -n "$LOYALTY_API_KEY" ]]; then
        headers+=(-H "X-API-Key: ${LOYALTY_API_KEY}")
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
    if [[ "$auth_required" == "true" ]] && [[ -z "$LOYALTY_API_KEY" ]] && [[ "$SKIP_AUTH" == "true" ]]; then
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

    # Check for version field
    if ! echo "$response" | jq -e '.version' > /dev/null 2>&1; then
        log_error "Missing 'version' field"
        return 1
    fi

    return 0
}

check_balance_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for balance field
    if ! echo "$response" | jq -e '.data.balance' > /dev/null 2>&1; then
        log_error "Missing 'data.balance' field"
        return 1
    fi

    return 0
}

check_currency_operation_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for new_balance field
    if ! echo "$response" | jq -e '.data.new_balance' > /dev/null 2>&1; then
        log_error "Missing 'data.new_balance' field"
        return 1
    fi

    return 0
}

check_leaderboard_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for leaderboard array
    if ! echo "$response" | jq -e '.data.leaderboard' > /dev/null 2>&1; then
        log_error "Missing 'data.leaderboard' field"
        return 1
    fi

    return 0
}

check_config_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for earning_rate field
    if ! echo "$response" | jq -e '.data.earning_rate' > /dev/null 2>&1; then
        log_error "Missing 'data.earning_rate' field"
        return 1
    fi

    return 0
}

check_giveaway_create_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for giveaway_id field
    if ! echo "$response" | jq -e '.data.giveaway_id' > /dev/null 2>&1; then
        log_error "Missing 'data.giveaway_id' field"
        return 1
    fi

    # Store giveaway ID for later tests
    GIVEAWAY_ID=$(echo "$response" | jq -r '.data.giveaway_id')
    log_verbose "Stored giveaway ID: $GIVEAWAY_ID"

    return 0
}

check_giveaway_list_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for giveaways array
    if ! echo "$response" | jq -e '.data.giveaways' > /dev/null 2>&1; then
        log_error "Missing 'data.giveaways' field"
        return 1
    fi

    return 0
}

check_giveaway_enter_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for success field
    if ! echo "$response" | jq -e '.data.success' > /dev/null 2>&1; then
        log_error "Missing 'data.success' field"
        return 1
    fi

    return 0
}

check_game_result_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for result field
    if ! echo "$response" | jq -e '.data.result' > /dev/null 2>&1; then
        log_error "Missing 'data.result' field"
        return 1
    fi

    return 0
}

check_game_stats_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for stats field
    if ! echo "$response" | jq -e '.data.stats' > /dev/null 2>&1; then
        log_error "Missing 'data.stats' field"
        return 1
    fi

    return 0
}

check_duel_challenge_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for duel_id field
    if ! echo "$response" | jq -e '.data.duel_id' > /dev/null 2>&1; then
        log_error "Missing 'data.duel_id' field"
        return 1
    fi

    # Store duel ID for later tests
    DUEL_ID=$(echo "$response" | jq -r '.data.duel_id')
    log_verbose "Stored duel ID: $DUEL_ID"

    return 0
}

check_duel_list_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for duels array
    if ! echo "$response" | jq -e '.data.duels' > /dev/null 2>&1; then
        log_error "Missing 'data.duels' field"
        return 1
    fi

    return 0
}

check_gear_categories_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for categories array
    if ! echo "$response" | jq -e '.data.categories' > /dev/null 2>&1; then
        log_error "Missing 'data.categories' field"
        return 1
    fi

    return 0
}

check_gear_shop_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for items array
    if ! echo "$response" | jq -e '.data.items' > /dev/null 2>&1; then
        log_error "Missing 'data.items' field"
        return 1
    fi

    return 0
}

check_gear_inventory_response() {
    local response="$1"

    # Check for data field
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for inventory array
    if ! echo "$response" | jq -e '.data.inventory' > /dev/null 2>&1; then
        log_error "Missing 'data.inventory' field"
        return 1
    fi

    return 0
}

################################################################################
# Test Cases - Health
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

################################################################################
# Test Cases - Currency
################################################################################

test_currency_balance() {
    run_test \
        "GET /api/v1/currency/1/balance/test-user-1" \
        "GET" \
        "/api/v1/currency/1/balance/test-user-1" \
        "" \
        "200" \
        "false" \
        "check_balance_response"
}

test_currency_add() {
    local data='{"user_id":"test-user-1","amount":100,"reason":"Test addition"}'
    run_test \
        "POST /api/v1/currency/1/add" \
        "POST" \
        "/api/v1/currency/1/add" \
        "$data" \
        "200" \
        "false" \
        "check_currency_operation_response"
}

test_currency_remove() {
    local data='{"user_id":"test-user-1","amount":50,"reason":"Test removal"}'
    run_test \
        "POST /api/v1/currency/1/remove" \
        "POST" \
        "/api/v1/currency/1/remove" \
        "$data" \
        "200" \
        "false" \
        "check_currency_operation_response"
}

test_currency_transfer() {
    local data='{"from_user_id":"test-user-1","to_user_id":"test-user-2","amount":25,"reason":"Test transfer"}'
    run_test \
        "POST /api/v1/currency/1/transfer" \
        "POST" \
        "/api/v1/currency/1/transfer" \
        "$data" \
        "200" \
        "false" \
        "check_currency_operation_response"
}

test_currency_leaderboard() {
    run_test \
        "GET /api/v1/currency/1/leaderboard" \
        "GET" \
        "/api/v1/currency/1/leaderboard" \
        "" \
        "200" \
        "false" \
        "check_leaderboard_response"
}

################################################################################
# Test Cases - Earning Config
################################################################################

test_config_get() {
    run_test \
        "GET /api/v1/config/1" \
        "GET" \
        "/api/v1/config/1" \
        "" \
        "200" \
        "false" \
        "check_config_response"
}

test_config_update() {
    local data='{"earning_rate":10,"interval_minutes":5,"activity_bonus":true}'
    run_test \
        "PUT /api/v1/config/1" \
        "PUT" \
        "/api/v1/config/1" \
        "$data" \
        "200" \
        "false" \
        "check_config_response"
}

################################################################################
# Test Cases - Giveaways
################################################################################

test_giveaway_create() {
    local data='{"title":"Test Giveaway","description":"Test giveaway for API testing","prize":"100 points","entry_cost":10,"max_entries":50,"duration_minutes":60}'
    run_test \
        "POST /api/v1/giveaways/1" \
        "POST" \
        "/api/v1/giveaways/1" \
        "$data" \
        "200" \
        "false" \
        "check_giveaway_create_response"
}

test_giveaway_list() {
    run_test \
        "GET /api/v1/giveaways/1" \
        "GET" \
        "/api/v1/giveaways/1" \
        "" \
        "200" \
        "false" \
        "check_giveaway_list_response"
}

test_giveaway_enter() {
    if [[ -z "$GIVEAWAY_ID" ]]; then
        log_skip "POST /api/v1/giveaways/1/{id}/enter (no giveaway ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    local data='{"user_id":"test-user-1"}'
    run_test \
        "POST /api/v1/giveaways/1/${GIVEAWAY_ID}/enter" \
        "POST" \
        "/api/v1/giveaways/1/${GIVEAWAY_ID}/enter" \
        "$data" \
        "200" \
        "false" \
        "check_giveaway_enter_response"
}

test_giveaway_draw() {
    if [[ -z "$GIVEAWAY_ID" ]]; then
        log_skip "POST /api/v1/giveaways/1/{id}/draw (no giveaway ID)"
        ((TESTS_SKIPPED++))
        return 0
    fi

    run_test \
        "POST /api/v1/giveaways/1/${GIVEAWAY_ID}/draw" \
        "POST" \
        "/api/v1/giveaways/1/${GIVEAWAY_ID}/draw" \
        "" \
        "200" \
        "false"
}

################################################################################
# Test Cases - Minigames
################################################################################

test_game_slots() {
    local data='{"user_id":"test-user-1","bet_amount":10}'
    run_test \
        "POST /api/v1/games/1/slots" \
        "POST" \
        "/api/v1/games/1/slots" \
        "$data" \
        "200" \
        "false" \
        "check_game_result_response"
}

test_game_coinflip() {
    local data='{"user_id":"test-user-1","bet_amount":10,"choice":"heads"}'
    run_test \
        "POST /api/v1/games/1/coinflip" \
        "POST" \
        "/api/v1/games/1/coinflip" \
        "$data" \
        "200" \
        "false" \
        "check_game_result_response"
}

test_game_roulette() {
    local data='{"user_id":"test-user-1","bet_amount":10,"bet_type":"color","bet_value":"red"}'
    run_test \
        "POST /api/v1/games/1/roulette" \
        "POST" \
        "/api/v1/games/1/roulette" \
        "$data" \
        "200" \
        "false" \
        "check_game_result_response"
}

test_game_stats() {
    run_test \
        "GET /api/v1/games/1/stats/test-user-1" \
        "GET" \
        "/api/v1/games/1/stats/test-user-1" \
        "" \
        "200" \
        "false" \
        "check_game_stats_response"
}

################################################################################
# Test Cases - Duels
################################################################################

test_duel_challenge() {
    local data='{"challenger_id":"test-user-1","opponent_id":"test-user-2","wager":20}'
    run_test \
        "POST /api/v1/duels/1/challenge" \
        "POST" \
        "/api/v1/duels/1/challenge" \
        "$data" \
        "200" \
        "false" \
        "check_duel_challenge_response"
}

test_duel_pending() {
    run_test \
        "GET /api/v1/duels/1/pending/test-user-1" \
        "GET" \
        "/api/v1/duels/1/pending/test-user-1" \
        "" \
        "200" \
        "false" \
        "check_duel_list_response"
}

test_duel_stats() {
    run_test \
        "GET /api/v1/duels/1/stats/test-user-1" \
        "GET" \
        "/api/v1/duels/1/stats/test-user-1" \
        "" \
        "200" \
        "false" \
        "check_game_stats_response"
}

test_duel_leaderboard() {
    run_test \
        "GET /api/v1/duels/1/leaderboard" \
        "GET" \
        "/api/v1/duels/1/leaderboard" \
        "" \
        "200" \
        "false" \
        "check_leaderboard_response"
}

################################################################################
# Test Cases - Gear
################################################################################

test_gear_categories() {
    run_test \
        "GET /api/v1/gear/categories" \
        "GET" \
        "/api/v1/gear/categories" \
        "" \
        "200" \
        "false" \
        "check_gear_categories_response"
}

test_gear_shop() {
    run_test \
        "GET /api/v1/gear/1/shop" \
        "GET" \
        "/api/v1/gear/1/shop" \
        "" \
        "200" \
        "false" \
        "check_gear_shop_response"
}

test_gear_inventory() {
    run_test \
        "GET /api/v1/gear/1/inventory/test-user-1" \
        "GET" \
        "/api/v1/gear/1/inventory/test-user-1" \
        "" \
        "200" \
        "false" \
        "check_gear_inventory_response"
}

test_gear_buy() {
    local data='{"user_id":"test-user-1","item_id":"test-item-1","quantity":1}'
    run_test \
        "POST /api/v1/gear/1/buy" \
        "POST" \
        "/api/v1/gear/1/buy" \
        "$data" \
        "200" \
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
                LOYALTY_URL="$2"
                shift 2
                ;;
            --api-key)
                LOYALTY_API_KEY="$2"
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
    log_info "WaddleBot Loyalty Interaction Module API Test Suite"
    log_info "======================================================================"
    log_info "Loyalty Module URL: $LOYALTY_URL"
    log_info "API Key: ${LOYALTY_API_KEY:+[SET]}${LOYALTY_API_KEY:-[NOT SET]}"
    log_info "Verbose: $VERBOSE"
    log_info "Skip Auth Tests: $SKIP_AUTH"
    log_info "======================================================================"
    echo ""

    # Run tests
    log_info "Running Health Tests..."
    test_health
    echo ""

    log_info "Running Currency Tests..."
    test_currency_balance
    test_currency_add
    test_currency_remove
    test_currency_transfer
    test_currency_leaderboard
    echo ""

    log_info "Running Earning Config Tests..."
    test_config_get
    test_config_update
    echo ""

    log_info "Running Giveaway Tests..."
    test_giveaway_create
    test_giveaway_list
    test_giveaway_enter
    test_giveaway_draw
    echo ""

    log_info "Running Minigame Tests..."
    test_game_slots
    test_game_coinflip
    test_game_roulette
    test_game_stats
    echo ""

    log_info "Running Duel Tests..."
    test_duel_challenge
    test_duel_pending
    test_duel_stats
    test_duel_leaderboard
    echo ""

    log_info "Running Gear Tests..."
    test_gear_categories
    test_gear_shop
    test_gear_inventory
    test_gear_buy
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
