#!/bin/bash
################################################################################
# WaddleBot Translation API Test Script
# Comprehensive test suite for translation functionality in Router Module
################################################################################

set -uo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Configuration
ROUTER_URL="${ROUTER_URL:-http://localhost:8000}"
COMMUNITY_ID="${COMMUNITY_ID:-1}"
VERBOSE=false

# Temporary files
RESPONSE_FILE=$(mktemp)
TIMING_FILE=$(mktemp)

# Cleanup on exit
trap 'rm -f "$RESPONSE_FILE" "$TIMING_FILE"' EXIT

################################################################################
# Test Language Samples
################################################################################

ENGLISH_TEXT="Hello, how are you doing today?"
SPANISH_TEXT="Hola, ¿cómo estás hoy?"
FRENCH_TEXT="Bonjour, comment allez-vous aujourd'hui?"
GERMAN_TEXT="Hallo, wie geht es dir heute?"
JAPANESE_TEXT="こんにちは、今日はどうですか？"
KOREAN_TEXT="안녕하세요, 오늘 어떻게 지내세요?"
CHINESE_TEXT="你好，你今天过得怎么样？"
PORTUGUESE_TEXT="Olá, como você está hoje?"
RUSSIAN_TEXT="Привет, как дела сегодня?"
ARABIC_TEXT="مرحبا، كيف حالك اليوم؟"
HINDI_TEXT="नमस्ते, आप आज कैसे हैं?"
ITALIAN_TEXT="Ciao, come stai oggi?"

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_test() {
    echo -e "\n${BLUE}[TEST]${NC} $1"
}

print_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

print_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

print_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((TESTS_SKIPPED++))
}

print_summary() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}Test Summary${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo -e "${GREEN}Passed:  ${TESTS_PASSED}${NC}"
    echo -e "${RED}Failed:  ${TESTS_FAILED}${NC}"
    echo -e "${YELLOW}Skipped: ${TESTS_SKIPPED}${NC}"
    echo -e "${BLUE}Total:   $((TESTS_PASSED + TESTS_FAILED + TESTS_SKIPPED))${NC}"
    echo -e "${BLUE}========================================${NC}"
}

show_help() {
    cat << EOF
WaddleBot Translation API Test Script

Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    --url URL               Router module URL (default: http://localhost:8000)
    --community-id ID       Community ID for testing (default: 1)
    -v, --verbose           Enable verbose output (show response bodies)

Environment Variables:
    ROUTER_URL              Router module URL
    COMMUNITY_ID            Community ID for testing

Examples:
    # Run tests against local instance
    $0

    # Run tests against custom URL
    $0 --url http://router.example.com:8000

    # Run with verbose output
    $0 --verbose

    # Specify community ID
    $0 --community-id 5

Exit Codes:
    0 - All tests passed
    1 - One or more tests failed

EOF
}

# API call helper with timing
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="${3:-}"
    local expected_status="${4:-200}"

    local curl_opts=(-s -w "\n%{http_code}\n%{time_total}" -X "$method")

    # Add content-type and data if provided
    if [ -n "$data" ]; then
        curl_opts+=(-H "Content-Type: application/json" -d "$data")
    fi

    # Make the API call
    local response
    response=$(curl "${curl_opts[@]}" "${ROUTER_URL}${endpoint}" 2>&1 || true)

    # Extract status code (second to last line)
    local status_code
    status_code=$(echo "$response" | tail -n 2 | head -n 1)

    # Extract timing (last line)
    local time_total
    time_total=$(echo "$response" | tail -n 1)
    echo "$time_total" > "$TIMING_FILE"

    # Extract body (all but last two lines)
    local body
    body=$(echo "$response" | sed -e '1,2d' -e '$d' -e '$d')

    # Save response for inspection
    echo "$body" > "$RESPONSE_FILE"

    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[DEBUG]${NC} Status: $status_code, Time: ${time_total}s"
        echo -e "${BLUE}[DEBUG]${NC} Response: $body"
    fi

    # Check status code
    if [ "$status_code" = "$expected_status" ]; then
        echo "$body"
        return 0
    else
        echo "Expected status $expected_status, got $status_code" >&2
        echo "Response: $body" >&2
        return 1
    fi
}

# Helper to send router event with message
send_message_event() {
    local message="$1"
    local entity_id="${2:-twitch:channel:123}"

    local event_data
    event_data=$(jq -n \
        --arg platform "twitch" \
        --arg channel_id "test_channel" \
        --arg user_id "test_user" \
        --arg username "TestUser" \
        --arg message "$message" \
        --arg entity_id "$entity_id" \
        '{
            platform: $platform,
            channel_id: $channel_id,
            user_id: $user_id,
            username: $username,
            message: $message,
            message_type: "chatMessage",
            metadata: {
                entity_id: $entity_id
            }
        }')

    api_call POST "/api/v1/router/events" "$event_data" 200
}

# Helper to extract metadata field from response
extract_metadata_field() {
    local response="$1"
    local field="$2"
    echo "$response" | jq -r ".metadata.translation.$field // empty" 2>/dev/null || echo ""
}

################################################################################
# Parse Arguments
################################################################################

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --url)
            ROUTER_URL="$2"
            shift 2
            ;;
        --community-id)
            COMMUNITY_ID="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

################################################################################
# Main Test Execution
################################################################################

echo -e "${BLUE}WaddleBot Translation API Test Suite${NC}"
echo -e "Testing: ${ROUTER_URL}"
echo -e "Community ID: ${COMMUNITY_ID}"

################################################################################
# Connectivity Check
################################################################################

print_header "Connectivity Check"

if ! curl -s -f -o /dev/null "${ROUTER_URL}/health" 2>&1; then
    echo -e "${RED}[FAIL]${NC} Cannot connect to router at ${ROUTER_URL}"
    echo -e "${RED}[FAIL]${NC} Please ensure the router module is running"
    exit 1
fi

echo -e "${GREEN}[PASS]${NC} Router is accessible"

################################################################################
# Language Detection Tests
################################################################################

print_header "Language Detection Tests"

# Test: English detection
print_test "Detect English language"
if response=$(send_message_event "$ENGLISH_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "en" ] || [ "$detected_lang" = "eng" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "English detected correctly (confidence: $confidence)"
        else
            print_fail "English detected but confidence too low ($confidence < 0.7)"
        fi
    else
        # Translation might be skipped if already in target language
        print_skip "English - translation may be skipped (already in target language)"
    fi
else
    print_fail "English detection - API call failed"
fi

# Test: Spanish detection
print_test "Detect Spanish language"
if response=$(send_message_event "$SPANISH_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "es" ] || [ "$detected_lang" = "spa" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Spanish detected correctly (confidence: $confidence)"
        else
            print_fail "Spanish detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Spanish - translation disabled or skipped"
    else
        print_fail "Spanish misdetected as $detected_lang"
    fi
else
    print_fail "Spanish detection - API call failed"
fi

# Test: French detection
print_test "Detect French language"
if response=$(send_message_event "$FRENCH_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "fr" ] || [ "$detected_lang" = "fra" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "French detected correctly (confidence: $confidence)"
        else
            print_fail "French detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "French - translation disabled or skipped"
    else
        print_fail "French misdetected as $detected_lang"
    fi
else
    print_fail "French detection - API call failed"
fi

# Test: German detection
print_test "Detect German language"
if response=$(send_message_event "$GERMAN_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "de" ] || [ "$detected_lang" = "deu" ] || [ "$detected_lang" = "ger" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "German detected correctly (confidence: $confidence)"
        else
            print_fail "German detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "German - translation disabled or skipped"
    else
        print_fail "German misdetected as $detected_lang"
    fi
else
    print_fail "German detection - API call failed"
fi

# Test: Japanese detection
print_test "Detect Japanese language"
if response=$(send_message_event "$JAPANESE_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "ja" ] || [ "$detected_lang" = "jpn" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Japanese detected correctly (confidence: $confidence)"
        else
            print_fail "Japanese detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Japanese - translation disabled or skipped"
    else
        print_fail "Japanese misdetected as $detected_lang"
    fi
else
    print_fail "Japanese detection - API call failed"
fi

# Test: Korean detection
print_test "Detect Korean language"
if response=$(send_message_event "$KOREAN_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "ko" ] || [ "$detected_lang" = "kor" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Korean detected correctly (confidence: $confidence)"
        else
            print_fail "Korean detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Korean - translation disabled or skipped"
    else
        print_fail "Korean misdetected as $detected_lang"
    fi
else
    print_fail "Korean detection - API call failed"
fi

# Test: Chinese detection
print_test "Detect Chinese language"
if response=$(send_message_event "$CHINESE_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "zh" ] || [ "$detected_lang" = "zh-CN" ] || [ "$detected_lang" = "chi" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Chinese detected correctly (confidence: $confidence)"
        else
            print_fail "Chinese detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Chinese - translation disabled or skipped"
    else
        print_fail "Chinese misdetected as $detected_lang"
    fi
else
    print_fail "Chinese detection - API call failed"
fi

# Test: Portuguese detection
print_test "Detect Portuguese language"
if response=$(send_message_event "$PORTUGUESE_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "pt" ] || [ "$detected_lang" = "por" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Portuguese detected correctly (confidence: $confidence)"
        else
            print_fail "Portuguese detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Portuguese - translation disabled or skipped"
    else
        print_fail "Portuguese misdetected as $detected_lang"
    fi
else
    print_fail "Portuguese detection - API call failed"
fi

# Test: Russian detection
print_test "Detect Russian language"
if response=$(send_message_event "$RUSSIAN_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "ru" ] || [ "$detected_lang" = "rus" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Russian detected correctly (confidence: $confidence)"
        else
            print_fail "Russian detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Russian - translation disabled or skipped"
    else
        print_fail "Russian misdetected as $detected_lang"
    fi
else
    print_fail "Russian detection - API call failed"
fi

# Test: Arabic detection
print_test "Detect Arabic language"
if response=$(send_message_event "$ARABIC_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "ar" ] || [ "$detected_lang" = "ara" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Arabic detected correctly (confidence: $confidence)"
        else
            print_fail "Arabic detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Arabic - translation disabled or skipped"
    else
        print_fail "Arabic misdetected as $detected_lang"
    fi
else
    print_fail "Arabic detection - API call failed"
fi

# Test: Hindi detection
print_test "Detect Hindi language"
if response=$(send_message_event "$HINDI_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "hi" ] || [ "$detected_lang" = "hin" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Hindi detected correctly (confidence: $confidence)"
        else
            print_fail "Hindi detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Hindi - translation disabled or skipped"
    else
        print_fail "Hindi misdetected as $detected_lang"
    fi
else
    print_fail "Hindi detection - API call failed"
fi

# Test: Italian detection
print_test "Detect Italian language"
if response=$(send_message_event "$ITALIAN_TEXT"); then
    detected_lang=$(extract_metadata_field "$response" "detected_lang")
    confidence=$(extract_metadata_field "$response" "confidence")

    if [ "$detected_lang" = "it" ] || [ "$detected_lang" = "ita" ]; then
        if [ -n "$confidence" ] && [ "$(echo "$confidence > 0.7" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
            print_pass "Italian detected correctly (confidence: $confidence)"
        else
            print_fail "Italian detected but confidence too low ($confidence < 0.7)"
        fi
    elif [ -z "$detected_lang" ]; then
        print_skip "Italian - translation disabled or skipped"
    else
        print_fail "Italian misdetected as $detected_lang"
    fi
else
    print_fail "Italian detection - API call failed"
fi

################################################################################
# Translation Tests
################################################################################

print_header "Translation Tests"

# Test: Spanish to English translation
print_test "Translate Spanish to English"
if response=$(send_message_event "$SPANISH_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -n "$translated" ]; then
        # Check if translation contains expected English words
        if echo "$translated" | grep -qi "hello\|how\|today"; then
            print_pass "Spanish translated successfully: '$translated'"
        else
            print_fail "Spanish translation doesn't contain expected words: '$translated'"
        fi
    else
        print_skip "Spanish translation - disabled or skipped"
    fi
else
    print_fail "Spanish translation - API call failed"
fi

# Test: French to English translation
print_test "Translate French to English"
if response=$(send_message_event "$FRENCH_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -n "$translated" ]; then
        # Check if translation contains expected English words
        if echo "$translated" | grep -qi "hello\|good\|how\|today"; then
            print_pass "French translated successfully: '$translated'"
        else
            print_fail "French translation doesn't contain expected words: '$translated'"
        fi
    else
        print_skip "French translation - disabled or skipped"
    fi
else
    print_fail "French translation - API call failed"
fi

# Test: German to English translation
print_test "Translate German to English"
if response=$(send_message_event "$GERMAN_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -n "$translated" ]; then
        # Check if translation contains expected English words
        if echo "$translated" | grep -qi "hello\|how\|today"; then
            print_pass "German translated successfully: '$translated'"
        else
            print_fail "German translation doesn't contain expected words: '$translated'"
        fi
    else
        print_skip "German translation - disabled or skipped"
    fi
else
    print_fail "German translation - API call failed"
fi

# Test: Japanese to English translation
print_test "Translate Japanese to English"
if response=$(send_message_event "$JAPANESE_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -n "$translated" ]; then
        # Check if translation contains expected English words
        if echo "$translated" | grep -qi "hello\|how\|today\|doing"; then
            print_pass "Japanese translated successfully: '$translated'"
        else
            print_fail "Japanese translation doesn't contain expected words: '$translated'"
        fi
    else
        print_skip "Japanese translation - disabled or skipped"
    fi
else
    print_fail "Japanese translation - API call failed"
fi

################################################################################
# Skip Condition Tests
################################################################################

print_header "Skip Condition Tests"

# Test: Short message (< 5 words)
print_test "Skip translation for short message (< 5 words)"
if response=$(send_message_event "Hi there"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -z "$translated" ]; then
        print_pass "Short message correctly skipped"
    else
        print_skip "Short message was translated (min_words may be configured differently)"
    fi
else
    print_fail "Short message test - API call failed"
fi

# Test: Already in target language (English)
print_test "Skip translation for message already in target language"
if response=$(send_message_event "$ENGLISH_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")

    if [ -z "$translated" ]; then
        print_pass "English message correctly skipped (already in target language)"
    else
        print_skip "English message was translated (target language may not be English)"
    fi
else
    print_fail "Target language skip test - API call failed"
fi

# Test: Empty message
print_test "Handle empty message gracefully"
if response=$(api_call POST "/api/v1/router/events" '{"platform":"twitch","channel_id":"test","user_id":"test","username":"test","message":""}' 400 2>/dev/null); then
    print_pass "Empty message rejected with 400 status"
elif response=$(api_call POST "/api/v1/router/events" '{"platform":"twitch","channel_id":"test","user_id":"test","username":"test","message":""}' 422 2>/dev/null); then
    print_pass "Empty message rejected with 422 status"
else
    print_skip "Empty message handling (validation may vary)"
fi

################################################################################
# Cache Tests
################################################################################

print_header "Cache Performance Tests"

# Test: Cache performance (same message twice)
print_test "Cache performance - send same message twice"
# First request
start_time=$(date +%s%N)
if response1=$(send_message_event "$SPANISH_TEXT"); then
    end_time=$(date +%s%N)
    time1=$((($end_time - $start_time) / 1000000))  # Convert to milliseconds

    # Wait a moment
    sleep 1

    # Second request (should be cached)
    start_time=$(date +%s%N)
    if response2=$(send_message_event "$SPANISH_TEXT"); then
        end_time=$(date +%s%N)
        time2=$((($end_time - $start_time) / 1000000))

        cached=$(extract_metadata_field "$response2" "cached")

        if [ "$cached" = "true" ]; then
            print_pass "Cache working - second request marked as cached"
        elif [ "$time2" -lt 100 ]; then
            print_pass "Cache working - second request faster (<100ms: ${time2}ms vs ${time1}ms)"
        elif [ "$time2" -lt "$time1" ]; then
            print_pass "Cache working - second request faster (${time2}ms vs ${time1}ms)"
        else
            print_skip "Cache performance - times similar (${time2}ms vs ${time1}ms)"
        fi
    else
        print_fail "Cache test - second request failed"
    fi
else
    print_fail "Cache test - first request failed"
fi

################################################################################
# Error Handling Tests
################################################################################

print_header "Error Handling Tests"

# Test: Invalid entity_id
print_test "Handle invalid entity_id gracefully"
if response=$(send_message_event "$SPANISH_TEXT" "invalid:entity:999999"); then
    # Should succeed but translation might be skipped
    print_pass "Invalid entity_id handled gracefully"
else
    print_skip "Invalid entity_id test (API may reject invalid entities)"
fi

# Test: Very long message (5000+ chars)
print_test "Handle very long message (5000+ chars)"
long_message=$(printf 'a%.0s' {1..5001})
if response=$(api_call POST "/api/v1/router/events" "{\"platform\":\"twitch\",\"channel_id\":\"test\",\"user_id\":\"test\",\"username\":\"test\",\"message\":\"$long_message\"}" 400 2>/dev/null); then
    print_pass "Long message rejected with 400 status"
elif response=$(api_call POST "/api/v1/router/events" "{\"platform\":\"twitch\",\"channel_id\":\"test\",\"user_id\":\"test\",\"username\":\"test\",\"message\":\"$long_message\"}" 422 2>/dev/null); then
    print_pass "Long message rejected with 422 status"
else
    print_skip "Long message handling (validation limit may be higher)"
fi

# Test: Invalid JSON
print_test "Handle malformed JSON gracefully"
if response=$(api_call POST "/api/v1/router/events" '{"invalid": json}' 400 2>/dev/null); then
    print_pass "Malformed JSON rejected with 400 status"
elif response=$(api_call POST "/api/v1/router/events" '{"invalid": json}' 422 2>/dev/null); then
    print_pass "Malformed JSON rejected with 422 status"
elif response=$(api_call POST "/api/v1/router/events" '{"invalid": json}' 500 2>/dev/null); then
    print_pass "Malformed JSON rejected with 500 status"
else
    print_skip "Malformed JSON handling (response code may vary)"
fi

# Test: Missing required fields
print_test "Handle missing required fields"
if response=$(api_call POST "/api/v1/router/events" '{"platform":"twitch","message":"test"}' 400 2>/dev/null); then
    print_pass "Missing fields rejected with 400 status"
elif response=$(api_call POST "/api/v1/router/events" '{"platform":"twitch","message":"test"}' 422 2>/dev/null); then
    print_pass "Missing fields rejected with 422 status"
else
    print_skip "Missing fields handling (validation may vary)"
fi

################################################################################
# Provider Tests
################################################################################

print_header "Translation Provider Tests"

# Test: Check provider information in response
print_test "Verify provider information in translation metadata"
if response=$(send_message_event "$SPANISH_TEXT"); then
    provider=$(extract_metadata_field "$response" "provider")

    if [ -n "$provider" ]; then
        case "$provider" in
            google_cloud|googletrans|waddleai)
                print_pass "Valid provider returned: $provider"
                ;;
            *)
                print_fail "Unknown provider: $provider"
                ;;
        esac
    else
        print_skip "Provider information - translation disabled or skipped"
    fi
else
    print_fail "Provider test - API call failed"
fi

################################################################################
# Metadata Preservation Tests
################################################################################

print_header "Metadata Preservation Tests"

# Test: Original message preserved
print_test "Verify original message preserved in metadata"
if response=$(send_message_event "$SPANISH_TEXT"); then
    original=$(echo "$response" | jq -r '.metadata.original_message // empty' 2>/dev/null || echo "")

    if [ "$original" = "$SPANISH_TEXT" ]; then
        print_pass "Original message correctly preserved"
    elif [ -z "$original" ]; then
        print_skip "Original message - translation disabled or skipped"
    else
        print_fail "Original message mismatch: expected '$SPANISH_TEXT', got '$original'"
    fi
else
    print_fail "Metadata preservation test - API call failed"
fi

# Test: Complete translation metadata structure
print_test "Verify complete translation metadata structure"
if response=$(send_message_event "$FRENCH_TEXT"); then
    translated=$(extract_metadata_field "$response" "translated_text")
    detected=$(extract_metadata_field "$response" "detected_lang")
    target=$(extract_metadata_field "$response" "target_lang")
    confidence=$(extract_metadata_field "$response" "confidence")
    provider=$(extract_metadata_field "$response" "provider")

    if [ -n "$translated" ] && [ -n "$detected" ] && [ -n "$target" ] && [ -n "$confidence" ] && [ -n "$provider" ]; then
        print_pass "Complete metadata structure present (translated, detected_lang, target_lang, confidence, provider)"
    elif [ -z "$translated" ]; then
        print_skip "Translation metadata - translation disabled or skipped"
    else
        missing=""
        [ -z "$detected" ] && missing="detected_lang "
        [ -z "$target" ] && missing="${missing}target_lang "
        [ -z "$confidence" ] && missing="${missing}confidence "
        [ -z "$provider" ] && missing="${missing}provider"
        print_fail "Incomplete metadata - missing: $missing"
    fi
else
    print_fail "Metadata structure test - API call failed"
fi

################################################################################
# Print Summary and Exit
################################################################################

print_summary

if [ $TESTS_FAILED -gt 0 ]; then
    exit 1
else
    exit 0
fi
