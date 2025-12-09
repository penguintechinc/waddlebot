#!/bin/bash
# Test API script for Analytics Core Module
# Tests all endpoints with proper error handling

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
ANALYTICS_URL="${ANALYTICS_URL:-http://localhost:8040}"
COMMUNITY_ID="${COMMUNITY_ID:-1}"
VERBOSE="${VERBOSE:-false}"

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Function to make API calls
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    local description=$4

    print_info "Testing: $description"

    if [ "$VERBOSE" = "true" ]; then
        echo "  URL: $ANALYTICS_URL$endpoint"
        echo "  Method: $method"
        if [ -n "$data" ]; then
            echo "  Data: $data"
        fi
    fi

    if [ -n "$data" ]; then
        response=$(curl -s -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$ANALYTICS_URL$endpoint")
    else
        response=$(curl -s -X "$method" "$ANALYTICS_URL$endpoint")
    fi

    if [ "$VERBOSE" = "true" ]; then
        echo "  Response: $response"
    fi

    # Check if response contains "success": true
    if echo "$response" | grep -q '"success": *true'; then
        print_success "$description"
        return 0
    else
        print_error "$description"
        echo "  Response: $response"
        return 1
    fi
}

# Main test execution
main() {
    echo "========================================="
    echo "Analytics Core Module API Tests"
    echo "========================================="
    echo "URL: $ANALYTICS_URL"
    echo "Community ID: $COMMUNITY_ID"
    echo "========================================="
    echo

    # Test health endpoints
    print_info "Testing health endpoints..."
    api_call GET "/health" "" "Health check"
    api_call GET "/healthz" "" "Kubernetes health check"
    echo

    # Test public API endpoints
    print_info "Testing public API endpoints..."
    api_call GET "/api/v1/analytics/status" "" "Module status"
    api_call GET "/api/v1/analytics/$COMMUNITY_ID/basic" "" "Get basic stats"
    api_call GET "/api/v1/analytics/$COMMUNITY_ID/metrics?metric_type=messages&bucket_size=1d" "" "Get time-series metrics"
    api_call GET "/api/v1/analytics/$COMMUNITY_ID/poll" "" "Poll for updates"
    api_call GET "/api/v1/analytics/$COMMUNITY_ID/config" "" "Get analytics config"
    echo

    # Test config update
    print_info "Testing config update..."
    api_call PUT "/api/v1/analytics/$COMMUNITY_ID/config" \
        '{"polling_interval_seconds": 60}' \
        "Update analytics config"
    echo

    # Test internal API endpoints
    print_info "Testing internal API endpoints..."
    api_call POST "/api/v1/internal/events" \
        '{"events": [{"event_type": "message", "platform": "discord", "platform_user_id": "123", "timestamp": "2025-01-01T00:00:00Z"}]}' \
        "Process events"
    api_call POST "/api/v1/internal/aggregate" \
        '{"community_id": '"$COMMUNITY_ID"', "force": false}' \
        "Trigger aggregation"
    echo

    echo "========================================="
    echo "All tests completed!"
    echo "========================================="
}

# Handle script arguments
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Usage: $0 [OPTIONS]"
    echo
    echo "Environment variables:"
    echo "  ANALYTICS_URL     Analytics module URL (default: http://localhost:8040)"
    echo "  COMMUNITY_ID      Community ID to test with (default: 1)"
    echo "  VERBOSE           Print detailed output (default: false)"
    echo
    echo "Examples:"
    echo "  $0"
    echo "  ANALYTICS_URL=http://analytics:8040 $0"
    echo "  VERBOSE=true $0"
    exit 0
fi

# Run tests
main
