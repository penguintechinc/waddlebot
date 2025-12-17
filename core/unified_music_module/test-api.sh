#!/usr/bin/env bash
################################################################################
# WaddleBot Unified Music Module API Test Script
################################################################################
#
# Comprehensive test suite for the Unified Music Module API endpoints.
# Tests health checks, provider status, queue operations, playback controls,
# and radio station management.
#
# Usage:
#   ./test-api.sh [OPTIONS]
#
# Options:
#   --help                  Show this help message
#   --url URL               Set music module URL (default: http://localhost:8051)
#   --community-id ID       Set community ID for testing (default: 1)
#   --verbose               Enable verbose output
#   --skip-health           Skip health check tests
#   --skip-queue            Skip queue operation tests
#   --skip-playback         Skip playback control tests
#   --skip-radio            Skip radio management tests
#   --skip-providers        Skip provider status tests
#
# Environment Variables:
#   MUSIC_MODULE_URL        Base URL for music module (default: http://localhost:8051)
#   COMMUNITY_ID            Community ID for testing (default: 1)
#   VERBOSE                 Enable verbose output (true/false)
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
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Configuration
MUSIC_MODULE_URL="${MUSIC_MODULE_URL:-http://localhost:8051}"
COMMUNITY_ID="${COMMUNITY_ID:-1}"
VERBOSE="${VERBOSE:-false}"
SKIP_HEALTH=false
SKIP_QUEUE=false
SKIP_PLAYBACK=false
SKIP_RADIO=false
SKIP_PROVIDERS=false

# Test data
TEST_TRACK_SPOTIFY="spotify:track:4cOdkLwLK6EsvSrLc5B4Iq"
TEST_TRACK_YOUTUBE="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
TEST_USER_ID="test_user_123"
TEST_STATION_URL="https://stream.example.com/radio.m3u8"

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
        echo -e "${CYAN}[VERBOSE]${NC} $*"
    fi
}

log_section() {
    echo ""
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
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

# Make HTTP request and return response with HTTP code
make_request() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"

    local url="${MUSIC_MODULE_URL}${endpoint}"
    local headers=(-H "Content-Type: application/json")

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
    local check_function="${6:-}"

    ((TESTS_RUN++))

    log_info "Running: $test_name"

    # Make request
    local result
    result=$(make_request "$method" "$endpoint" "$data")

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

check_healthz_response() {
    local response="$1"

    # Check for status field
    if ! echo "$response" | jq -e '.status' > /dev/null 2>&1; then
        log_error "Missing 'status' field"
        return 1
    fi

    local status
    status=$(echo "$response" | jq -r '.status')

    if [[ "$status" != "healthy" && "$status" != "degraded" ]]; then
        log_error "Service status unexpected: $status"
        return 1
    fi

    # Check for checks field
    if ! echo "$response" | jq -e '.checks' > /dev/null 2>&1; then
        log_error "Missing 'checks' field"
        return 1
    fi

    return 0
}

check_metrics_response() {
    local response="$1"

    # Metrics should contain Prometheus-style metrics
    if [[ -z "$response" ]]; then
        log_error "Empty metrics response"
        return 1
    fi

    # Check for at least one metric line
    if ! echo "$response" | grep -q "^[a-z_]"; then
        log_error "No valid metrics found"
        return 1
    fi

    return 0
}

check_status_response() {
    local response="$1"

    # Check for data.status field (wrapped in success_response)
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

    return 0
}

check_providers_response() {
    local response="$1"

    # Check for providers array or object
    if ! echo "$response" | jq -e '.data.providers' > /dev/null 2>&1; then
        log_error "Missing 'data.providers' field"
        return 1
    fi

    return 0
}

check_provider_status_response() {
    local response="$1"

    # Check for provider information
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Check for provider name or status
    if ! echo "$response" | jq -e '.data.name' > /dev/null 2>&1; then
        log_error "Missing provider 'name' field"
        return 1
    fi

    return 0
}

check_queue_response() {
    local response="$1"

    # Check for queue data
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    # Should have items array or similar
    if ! echo "$response" | jq -e '.data.items' > /dev/null 2>&1; then
        if ! echo "$response" | jq -e '.data | keys' > /dev/null 2>&1; then
            log_error "Queue data structure invalid"
            return 1
        fi
    fi

    return 0
}

check_playback_response() {
    local response="$1"

    # Check for playback state
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    return 0
}

check_radio_response() {
    local response="$1"

    # Check for radio station data
    if ! echo "$response" | jq -e '.data' > /dev/null 2>&1; then
        log_error "Missing 'data' field"
        return 1
    fi

    return 0
}

################################################################################
# Health & Monitoring Tests
################################################################################

test_health() {
    run_test \
        "GET /health" \
        "GET" \
        "/health" \
        "" \
        "200" \
        "check_health_response"
}

test_healthz() {
    run_test \
        "GET /healthz" \
        "GET" \
        "/healthz" \
        "" \
        "200" \
        "check_healthz_response"
}

test_metrics() {
    run_test \
        "GET /metrics" \
        "GET" \
        "/metrics" \
        "" \
        "200" \
        "check_metrics_response"
}

test_status() {
    run_test \
        "GET /api/v1/status" \
        "GET" \
        "/api/v1/status" \
        "" \
        "200" \
        "check_status_response"
}

################################################################################
# Provider Status Tests
################################################################################

test_providers_list() {
    run_test \
        "GET /api/v1/providers" \
        "GET" \
        "/api/v1/providers" \
        "" \
        "200" \
        "check_providers_response"
}

test_provider_spotify_status() {
    run_test \
        "GET /api/v1/providers/spotify/status" \
        "GET" \
        "/api/v1/providers/spotify/status" \
        "" \
        "200" \
        "check_provider_status_response"
}

test_provider_youtube_status() {
    run_test \
        "GET /api/v1/providers/youtube/status" \
        "GET" \
        "/api/v1/providers/youtube/status" \
        "" \
        "200" \
        "check_provider_status_response"
}

test_provider_soundcloud_status() {
    run_test \
        "GET /api/v1/providers/soundcloud/status" \
        "GET" \
        "/api/v1/providers/soundcloud/status" \
        "" \
        "200" \
        "check_provider_status_response"
}

################################################################################
# Queue Operation Tests
################################################################################

test_queue_get() {
    run_test \
        "GET /api/v1/queue/$COMMUNITY_ID" \
        "GET" \
        "/api/v1/queue/$COMMUNITY_ID" \
        "" \
        "200" \
        "check_queue_response"
}

test_queue_add_track() {
    local payload=$(cat <<EOF
{
  "track_url": "$TEST_TRACK_SPOTIFY",
  "requested_by_user_id": "$TEST_USER_ID",
  "provider": "spotify"
}
EOF
)

    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/add" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/add" \
        "$payload" \
        "200"
}

test_queue_add_youtube_track() {
    local payload=$(cat <<EOF
{
  "track_url": "$TEST_TRACK_YOUTUBE",
  "requested_by_user_id": "$TEST_USER_ID",
  "provider": "youtube"
}
EOF
)

    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/add (YouTube)" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/add" \
        "$payload" \
        "200"
}

test_queue_position_list() {
    run_test \
        "GET /api/v1/queue/$COMMUNITY_ID/position" \
        "GET" \
        "/api/v1/queue/$COMMUNITY_ID/position" \
        "" \
        "200" \
        "check_queue_response"
}

test_queue_vote_up() {
    # First, assume there's at least one track in queue
    local payload=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "direction": "up"
}
EOF
)

    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/vote/0" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/vote/0" \
        "$payload" \
        "200"
}

test_queue_vote_down() {
    local payload=$(cat <<EOF
{
  "user_id": "$TEST_USER_ID",
  "direction": "down"
}
EOF
)

    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/vote/0 (down)" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/vote/0" \
        "$payload" \
        "200"
}

test_queue_clear() {
    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/clear" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/clear" \
        "" \
        "200"
}

test_queue_skip() {
    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/skip" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/skip" \
        "" \
        "200"
}

test_queue_remove_track() {
    run_test \
        "DELETE /api/v1/queue/$COMMUNITY_ID/0" \
        "DELETE" \
        "/api/v1/queue/$COMMUNITY_ID/0" \
        "" \
        "200"
}

################################################################################
# Playback Control Tests
################################################################################

test_playback_play() {
    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/play" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/play" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_pause() {
    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/pause" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/pause" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_resume() {
    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/resume" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/resume" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_skip() {
    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/skip" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/skip" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_stop() {
    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/stop" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/stop" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_get_state() {
    run_test \
        "GET /api/v1/playback/$COMMUNITY_ID/state" \
        "GET" \
        "/api/v1/playback/$COMMUNITY_ID/state" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_now_playing() {
    run_test \
        "GET /api/v1/playback/$COMMUNITY_ID/now-playing" \
        "GET" \
        "/api/v1/playback/$COMMUNITY_ID/now-playing" \
        "" \
        "200" \
        "check_playback_response"
}

test_playback_set_volume() {
    local payload=$(cat <<EOF
{
  "volume": 75
}
EOF
)

    run_test \
        "POST /api/v1/playback/$COMMUNITY_ID/volume" \
        "POST" \
        "/api/v1/playback/$COMMUNITY_ID/volume" \
        "$payload" \
        "200"
}

################################################################################
# Radio Management Tests
################################################################################

test_radio_list_stations() {
    run_test \
        "GET /api/v1/radio/$COMMUNITY_ID/stations" \
        "GET" \
        "/api/v1/radio/$COMMUNITY_ID/stations" \
        "" \
        "200" \
        "check_radio_response"
}

test_radio_get_active_station() {
    run_test \
        "GET /api/v1/radio/$COMMUNITY_ID/active" \
        "GET" \
        "/api/v1/radio/$COMMUNITY_ID/active" \
        "" \
        "200"
}

test_radio_create_station() {
    local payload=$(cat <<EOF
{
  "name": "Test Radio Station",
  "provider": "icecast",
  "stream_url": "$TEST_STATION_URL",
  "bitrate": 128,
  "codec": "mp3"
}
EOF
)

    run_test \
        "POST /api/v1/radio/$COMMUNITY_ID/stations" \
        "POST" \
        "/api/v1/radio/$COMMUNITY_ID/stations" \
        "$payload" \
        "200" \
        "check_radio_response"
}

test_radio_switch_station() {
    # Switch to first available station (ID 0 or 1)
    run_test \
        "POST /api/v1/radio/$COMMUNITY_ID/switch" \
        "POST" \
        "/api/v1/radio/$COMMUNITY_ID/switch" \
        "" \
        "200"
}

test_radio_play() {
    run_test \
        "POST /api/v1/radio/$COMMUNITY_ID/play" \
        "POST" \
        "/api/v1/radio/$COMMUNITY_ID/play" \
        "" \
        "200" \
        "check_radio_response"
}

test_radio_stop() {
    run_test \
        "POST /api/v1/radio/$COMMUNITY_ID/stop" \
        "POST" \
        "/api/v1/radio/$COMMUNITY_ID/stop" \
        "" \
        "200"
}

test_radio_now_playing() {
    run_test \
        "GET /api/v1/radio/$COMMUNITY_ID/now-playing" \
        "GET" \
        "/api/v1/radio/$COMMUNITY_ID/now-playing" \
        "" \
        "200"
}

test_radio_delete_station() {
    # Try to delete a station (if one exists)
    run_test \
        "DELETE /api/v1/radio/$COMMUNITY_ID/stations/0" \
        "DELETE" \
        "/api/v1/radio/$COMMUNITY_ID/stations/0" \
        "" \
        "200"
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
        "404"
}

test_invalid_method() {
    run_test \
        "DELETE /api/v1/status" \
        "DELETE" \
        "/api/v1/status" \
        "" \
        "405"
}

test_malformed_json() {
    run_test \
        "POST /api/v1/queue/$COMMUNITY_ID/add (malformed)" \
        "POST" \
        "/api/v1/queue/$COMMUNITY_ID/add" \
        "{invalid json}" \
        "400"
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
                MUSIC_MODULE_URL="$2"
                shift 2
                ;;
            --community-id)
                COMMUNITY_ID="$2"
                shift 2
                ;;
            --verbose)
                VERBOSE="true"
                shift
                ;;
            --skip-health)
                SKIP_HEALTH="true"
                shift
                ;;
            --skip-queue)
                SKIP_QUEUE="true"
                shift
                ;;
            --skip-playback)
                SKIP_PLAYBACK="true"
                shift
                ;;
            --skip-radio)
                SKIP_RADIO="true"
                shift
                ;;
            --skip-providers)
                SKIP_PROVIDERS="true"
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
    log_info "WaddleBot Unified Music Module API Test Suite"
    log_info "======================================================================"
    log_info "Music Module URL:  $MUSIC_MODULE_URL"
    log_info "Community ID:      $COMMUNITY_ID"
    log_info "Verbose:           $VERBOSE"
    log_info "======================================================================"
    echo ""

    # Health & Monitoring Tests
    if [ "$SKIP_HEALTH" = "false" ]; then
        log_section "Health & Monitoring Tests"
        test_health
        test_healthz
        test_metrics
        test_status
        echo ""
    else
        ((TESTS_RUN += 4))
        ((TESTS_SKIPPED += 4))
        log_skip "Health check tests skipped"
    fi

    # Provider Status Tests
    if [ "$SKIP_PROVIDERS" = "false" ]; then
        log_section "Provider Status Tests"
        test_providers_list
        test_provider_spotify_status
        test_provider_youtube_status
        test_provider_soundcloud_status
        echo ""
    else
        ((TESTS_RUN += 4))
        ((TESTS_SKIPPED += 4))
        log_skip "Provider status tests skipped"
    fi

    # Queue Operation Tests
    if [ "$SKIP_QUEUE" = "false" ]; then
        log_section "Queue Operation Tests"
        test_queue_get
        test_queue_add_track
        test_queue_add_youtube_track
        test_queue_position_list
        test_queue_vote_up || true
        test_queue_vote_down || true
        test_queue_skip || true
        test_queue_clear
        echo ""
    else
        ((TESTS_RUN += 8))
        ((TESTS_SKIPPED += 8))
        log_skip "Queue operation tests skipped"
    fi

    # Playback Control Tests
    if [ "$SKIP_PLAYBACK" = "false" ]; then
        log_section "Playback Control Tests"
        test_playback_get_state
        test_playback_play || true
        test_playback_pause || true
        test_playback_resume || true
        test_playback_skip || true
        test_playback_stop || true
        test_playback_now_playing || true
        test_playback_set_volume || true
        echo ""
    else
        ((TESTS_RUN += 8))
        ((TESTS_SKIPPED += 8))
        log_skip "Playback control tests skipped"
    fi

    # Radio Management Tests
    if [ "$SKIP_RADIO" = "false" ]; then
        log_section "Radio Management Tests"
        test_radio_list_stations
        test_radio_get_active_station || true
        test_radio_create_station || true
        test_radio_switch_station || true
        test_radio_play || true
        test_radio_now_playing || true
        test_radio_stop || true
        echo ""
    else
        ((TESTS_RUN += 7))
        ((TESTS_SKIPPED += 7))
        log_skip "Radio management tests skipped"
    fi

    # Error Handling Tests
    log_section "Error Handling Tests"
    test_invalid_endpoint
    test_invalid_method
    test_malformed_json || true
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
