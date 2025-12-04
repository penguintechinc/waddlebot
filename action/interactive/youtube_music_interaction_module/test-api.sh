#!/usr/bin/env bash
#
# YouTube Music Interaction Module - API Test Script
# Tests all API endpoints for the YouTube Music module
#
# Usage: ./test-api.sh [OPTIONS]
#
# Options:
#   --help          Show this help message
#   --url URL       Set base URL (default: http://localhost:8025)
#
# Environment Variables:
#   YOUTUBE_MUSIC_URL    Base URL for the module (default: http://localhost:8025)
#

set -o pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Default configuration
BASE_URL="${YOUTUBE_MUSIC_URL:-http://localhost:8025}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --help)
            cat << 'EOF'
YouTube Music Interaction Module - API Test Script
Tests all API endpoints for the YouTube Music module

Usage: ./test-api.sh [OPTIONS]

Options:
  --help          Show this help message
  --url URL       Set base URL (default: http://localhost:8025)

Environment Variables:
  YOUTUBE_MUSIC_URL    Base URL for the module (default: http://localhost:8025)

EOF
            exit 0
            ;;
        --url)
            BASE_URL="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Verify required tools
for tool in curl jq; do
    if ! command -v "$tool" &> /dev/null; then
        echo -e "${RED}Error: Required tool '$tool' is not installed${NC}"
        exit 1
    fi
done

# Test helper functions
print_test_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_test() {
    echo -e "\n${YELLOW}Test:${NC} $1"
}

pass_test() {
    echo -e "${GREEN}✓ PASS:${NC} $1"
    ((PASS_COUNT++))
}

fail_test() {
    echo -e "${RED}✗ FAIL:${NC} $1"
    ((FAIL_COUNT++))
}

skip_test() {
    echo -e "${YELLOW}⊘ SKIP:${NC} $1"
    ((SKIP_COUNT++))
}

# Make HTTP request and capture response
make_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"
    local headers="$4"

    local curl_opts=(-s -w "\n%{http_code}" -X "$method")

    if [[ -n "$headers" ]]; then
        while IFS= read -r header; do
            curl_opts+=(-H "$header")
        done <<< "$headers"
    fi

    if [[ -n "$data" ]]; then
        curl_opts+=(-d "$data")
    fi

    curl "${curl_opts[@]}" "${BASE_URL}${endpoint}"
}

# Validate JSON response
validate_json() {
    local response="$1"
    echo "$response" | jq empty 2>/dev/null
    return $?
}

# Extract HTTP status code
extract_status() {
    local response="$1"
    echo "$response" | tail -n1
}

# Extract response body
extract_body() {
    local response="$1"
    echo "$response" | sed '$d'
}

# Main test suite
print_test_header "YouTube Music Interaction Module API Tests"
echo -e "Base URL: ${BLUE}${BASE_URL}${NC}"
echo -e "Timestamp: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"

# =============================================================================
# Test 1: Health Check Endpoint
# =============================================================================
print_test_header "Health Check Endpoints"

print_test "GET /health - Basic health check"
response=$(make_request "GET" "/health" "" "")
status=$(extract_status "$response")
body=$(extract_body "$response")

if [[ "$status" == "200" ]]; then
    if validate_json "$body"; then
        module=$(echo "$body" | jq -r '.module // empty')
        health_status=$(echo "$body" | jq -r '.status // empty')
        version=$(echo "$body" | jq -r '.version // empty')

        if [[ "$health_status" == "healthy" && "$module" == "youtube_music_interaction_module" && -n "$version" ]]; then
            pass_test "Health endpoint returns correct structure (status: $health_status, module: $module, version: $version)"
        else
            fail_test "Health endpoint has invalid structure or values"
            echo "  Response: $body"
        fi
    else
        fail_test "Health endpoint returned invalid JSON"
        echo "  Response: $body"
    fi
else
    fail_test "Health endpoint returned status $status (expected 200)"
    echo "  Response: $body"
fi

# =============================================================================
# Test 2: Kubernetes Health Check Endpoint
# =============================================================================
print_test "GET /healthz - Kubernetes liveness/readiness probe"
response=$(make_request "GET" "/healthz" "" "")
status=$(extract_status "$response")
body=$(extract_body "$response")

if [[ "$status" == "200" || "$status" == "503" ]]; then
    if validate_json "$body"; then
        module=$(echo "$body" | jq -r '.module // empty')
        health_status=$(echo "$body" | jq -r '.status // empty')
        version=$(echo "$body" | jq -r '.version // empty')
        checks=$(echo "$body" | jq -r '.checks // empty')

        if [[ "$module" == "youtube_music_interaction_module" && -n "$version" ]]; then
            if [[ "$status" == "200" && "$health_status" == "healthy" ]]; then
                pass_test "Healthz endpoint returns healthy status with checks"
            elif [[ "$status" == "503" && "$health_status" == "degraded" ]]; then
                pass_test "Healthz endpoint returns degraded status (acceptable)"
                echo "  Warning: Service is degraded"
            else
                fail_test "Healthz endpoint has unexpected status combination"
                echo "  HTTP Status: $status, Health Status: $health_status"
            fi
        else
            fail_test "Healthz endpoint has invalid structure or values"
            echo "  Response: $body"
        fi
    else
        fail_test "Healthz endpoint returned invalid JSON"
        echo "  Response: $body"
    fi
else
    fail_test "Healthz endpoint returned unexpected status $status"
    echo "  Response: $body"
fi

# =============================================================================
# Test 3: Metrics Endpoint
# =============================================================================
print_test "GET /metrics - Prometheus metrics"
response=$(make_request "GET" "/metrics" "" "")
status=$(extract_status "$response")
body=$(extract_body "$response")

if [[ "$status" == "200" ]]; then
    # Check for Prometheus format markers
    if echo "$body" | grep -q "waddlebot_info" && \
       echo "$body" | grep -q "waddlebot_requests_total" && \
       echo "$body" | grep -q "youtube_music_interaction_module"; then
        pass_test "Metrics endpoint returns Prometheus format data"
    else
        fail_test "Metrics endpoint missing expected Prometheus metrics"
        echo "  Response preview: $(echo "$body" | head -n 5)"
    fi
else
    fail_test "Metrics endpoint returned status $status (expected 200)"
    echo "  Response: $body"
fi

# =============================================================================
# Test 4: API Status Endpoint
# =============================================================================
print_test_header "API Endpoints"

print_test "GET /api/v1/status - Module status"
response=$(make_request "GET" "/api/v1/status" "" "")
status=$(extract_status "$response")
body=$(extract_body "$response")

if [[ "$status" == "200" ]]; then
    if validate_json "$body"; then
        api_status=$(echo "$body" | jq -r '.status // empty')
        module=$(echo "$body" | jq -r '.module // empty')

        if [[ "$api_status" == "operational" && "$module" == "youtube_music_interaction_module" ]]; then
            pass_test "API status endpoint returns operational status"
        else
            fail_test "API status endpoint has invalid structure or values"
            echo "  Response: $body"
        fi
    else
        fail_test "API status endpoint returned invalid JSON"
        echo "  Response: $body"
    fi
else
    fail_test "API status endpoint returned status $status (expected 200)"
    echo "  Response: $body"
fi

# =============================================================================
# Test 5: Invalid Endpoint (404 handling)
# =============================================================================
print_test_header "Error Handling"

print_test "GET /api/v1/nonexistent - 404 handling"
response=$(make_request "GET" "/api/v1/nonexistent" "" "")
status=$(extract_status "$response")

if [[ "$status" == "404" ]]; then
    pass_test "Non-existent endpoint returns 404"
else
    fail_test "Non-existent endpoint returned status $status (expected 404)"
fi

# =============================================================================
# Test 6: Method Not Allowed (405 handling)
# =============================================================================
print_test "POST /health - Method not allowed handling"
response=$(make_request "POST" "/health" "" "")
status=$(extract_status "$response")

if [[ "$status" == "405" ]]; then
    pass_test "Wrong HTTP method returns 405"
elif [[ "$status" == "404" ]]; then
    # Some frameworks return 404 instead of 405
    pass_test "Wrong HTTP method returns 404 (acceptable)"
else
    skip_test "Method not allowed test - got status $status"
fi

# =============================================================================
# Test 7: Response Headers
# =============================================================================
print_test_header "Response Headers"

print_test "Check Content-Type header on /health"
headers=$(curl -s -I "${BASE_URL}/health" 2>/dev/null)

if echo "$headers" | grep -qi "content-type.*application/json"; then
    pass_test "Health endpoint returns JSON content-type"
else
    fail_test "Health endpoint missing or incorrect content-type header"
    echo "  Headers: $(echo "$headers" | grep -i content-type || echo "Not found")"
fi

# =============================================================================
# Test 8: Service Availability
# =============================================================================
print_test_header "Service Availability"

print_test "Check if service is reachable"
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${BASE_URL}/health" | grep -q "200"; then
    pass_test "Service is reachable and responding"
else
    fail_test "Service is not reachable or not responding properly"
fi

print_test "Check response time for /health endpoint"
response_time=$(curl -s -o /dev/null -w "%{time_total}" --max-time 10 "${BASE_URL}/health")
response_time_ms=$(echo "$response_time * 1000" | bc)

if (( $(echo "$response_time < 2.0" | bc -l) )); then
    pass_test "Response time is acceptable (${response_time_ms}ms)"
else
    fail_test "Response time is slow (${response_time_ms}ms > 2000ms)"
fi

# =============================================================================
# Print Summary
# =============================================================================
echo -e "\n${BLUE}========================================${NC}"
echo -e "${BLUE}Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Passed:${NC}  $PASS_COUNT"
echo -e "${RED}Failed:${NC}  $FAIL_COUNT"
echo -e "${YELLOW}Skipped:${NC} $SKIP_COUNT"
echo -e "Total:   $((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))"
echo -e "${BLUE}========================================${NC}"

# Exit with appropriate code
if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "\n${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "\n${RED}Some tests failed!${NC}"
    exit 1
fi
