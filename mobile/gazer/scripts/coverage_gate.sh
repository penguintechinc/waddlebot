#!/usr/bin/env bash
# Fails the build when line coverage is below the given threshold, or when
# the coverage report contains zero examined source files -- a scanner
# pointed at nothing is a FAILURE, not a pass (critical-rules.md
# Verification Integrity: assert a non-zero denominator).
#
# Usage: coverage_gate.sh <threshold-percent> [report-path] [lcov|jacoco] [lib-root]
#   lcov mode (default): report-path defaults to coverage/lcov.info
#   jacoco mode: report-path defaults to
#     android/app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml
#
# lcov mode also drops generated-code SF: records before counting (R20):
# lib/**/*.g.dart, lib/**/*.freezed.dart, lib/pigeon/**, and
# lib/l10n/app_localizations*.dart are never hand-tested, so counting them
# either dilutes real coverage or masks it behind stale generated output.
# Whole SF:..end_of_record blocks are dropped, never partial edits inside
# a record. See scripts/coverage_gate_selftest.sh for the synthetic-fixture
# proof of this filtering behavior.
#
# I7 (final-review-platform.md): `flutter test --coverage` only reports libraries a test
# actually loads, so a hand-written lib/ file that no test imports (even transitively)
# contributes ZERO SF: records -- invisible to the raw percentage, not just under-covered.
# When lib-root is given (lcov mode only), the gate additionally compares the set of on-disk
# non-generated .dart files under it against the set of SF: records, failing loudly and by name
# if any hand-written file is completely absent from the report. The sole exemption is
# COMPLETENESS_ALLOWLIST below (R43): files with zero executable statements, which can never
# receive a record. The threshold percentage check is unaffected by that allowlist.
set -euo pipefail

THRESHOLD="${1:?usage: coverage_gate.sh <threshold-percent> [report-path] [lcov|jacoco] [lib-root]}"
REPORT_TYPE="${3:-lcov}"
LIB_ROOT="${4:-}"

# Portable (bash 3.2 compatible -- no mapfile/declare -A) filter: reads an
# lcov file on stdin, writes the lcov file with generated-path records
# removed to stdout, and writes "<total> <excluded>" (SF: record counts) to
# the file path given as $1.
filter_generated_lcov_records() {
  local counts_file="$1"
  awk -v counts_file="${counts_file}" '
    function is_generated(path) {
      if (path ~ /(^|\/)lib\/.*\.g\.dart$/)                         return 1
      if (path ~ /(^|\/)lib\/.*\.freezed\.dart$/)                   return 1
      if (path ~ /(^|\/)lib\/pigeon\//)                             return 1
      if (path ~ /(^|\/)lib\/l10n\/app_localizations[^\/]*\.dart$/) return 1
      return 0
    }
    /^SF:/ {
      total++
      path = $0
      sub(/^SF:/, "", path)
      skip = is_generated(path)
      if (skip) excluded++
      buffer = $0 "\n"
      next
    }
    {
      buffer = buffer $0 "\n"
      if ($0 == "end_of_record") {
        if (!skip) printf "%s", buffer
        buffer = ""
      }
      next
    }
    END {
      printf "%d %d\n", total + 0, excluded + 0 > counts_file
    }
  '
}

# R43 (integration #10): a hand-written lib/ file with ZERO executable statements can never
# receive an lcov SF: record, no matter what tests exist -- `flutter test --coverage` only emits
# records for libraries that contribute runtime code. Each entry below is such a file, matched as
# a path suffix, and each carries the reason it can never be covered. This list is the ONLY
# permitted omission: any other absent file still fails the completeness check below.
#   lib/config/constants.dart        -- const-only library: compile-time values, no runtime code
#                                       (test/config/constants_test.dart exercises them anyway)
#   lib/models/validation_issue.dart -- bare @freezed declaration; the whole implementation is
#                                       generated into validation_issue.freezed.dart, which the
#                                       generated-record filter above already excludes
COMPLETENESS_ALLOWLIST="lib/config/constants.dart lib/models/validation_issue.dart"

# I7 (final-review-platform.md) + R43: compares the SET of hand-written .dart files on disk under
# lib-root against the SET of SF: records in the filtered report, rather than only their counts --
# equal counts can still hide a swap (one file gains a record while another loses one). Prints the
# denominator and every offending path, and exits non-zero when any non-allowlisted file is absent.
report_missing_coverage_records() {
  local lib_root="$1" filtered_report="$2" allowlist="$3"
  python3 - "${lib_root}" "${filtered_report}" "${allowlist}" <<'COMPLETENESS_PY'
import os
import re
import sys

lib_root, report_path, allowlist_raw = sys.argv[1], sys.argv[2], sys.argv[3]
allowlist = [entry for entry in allowlist_raw.split() if entry]

GENERATED = (
    re.compile(r"\.g\.dart$"),
    re.compile(r"\.freezed\.dart$"),
    re.compile(r"(^|/)pigeon/"),
    re.compile(r"(^|/)l10n/app_localizations[^/]*\.dart$"),
)


def is_generated(path):
    """True when path matches one of the never-hand-tested generated-code shapes."""
    return any(pattern.search(path) for pattern in GENERATED)


def canonical(path):
    """Absolute, symlink-free path, so a relative SF: record and an on-disk walk compare equal."""
    return os.path.realpath(os.path.abspath(path))


def display(path):
    """Path as the reader would type it: relative under cwd, absolute anywhere else."""
    cwd = canonical(os.getcwd())
    return os.path.relpath(path, cwd) if path.startswith(cwd + os.sep) else path


on_disk = sorted(
    canonical(os.path.join(dirpath, name))
    for dirpath, _dirnames, filenames in os.walk(lib_root)
    for name in filenames
    if name.endswith(".dart") and not is_generated(os.path.join(dirpath, name))
)

with open(report_path) as handle:
    reported = {
        canonical(line[len("SF:"):].strip())
        for line in handle
        if line.startswith("SF:")
    }

missing = [path for path in on_disk if path not in reported]
allowed = [p for p in missing if any(p.endswith("/" + entry) for entry in allowlist)]
offending = [p for p in missing if p not in allowed]

# A zero denominator means the walk found nothing -- a scanner pointed at the wrong root
# reports clean, so treat it as a failure rather than a silent pass.
if not on_disk:
    print(
        "coverage_gate: on-disk completeness check FAILED -- zero hand-written .dart file(s) "
        "found under %s/; a scan that examines nothing is a failure, not a pass" % lib_root,
        file=sys.stderr,
    )
    sys.exit(1)

for path in allowed:
    print(
        "coverage_gate: allowlisted (no executable statements, R43): %s" % display(path)
    )

if offending:
    print(
        "coverage_gate: on-disk completeness check FAILED -- %d hand-written .dart file(s) "
        "under %s/, %d of them never loaded by any test (not merely under-covered):"
        % (len(on_disk), lib_root, len(offending)),
        file=sys.stderr,
    )
    for path in offending:
        print("  %s" % display(path), file=sys.stderr)
    sys.exit(1)

print(
    "coverage_gate: on-disk completeness check OK -- %d of %d hand-written .dart file(s) under "
    "%s/ appear in the coverage report, %d allowlisted as statement-free"
    % (len(on_disk) - len(allowed), len(on_disk), lib_root, len(allowed))
)
COMPLETENESS_PY
}

if [[ "${REPORT_TYPE}" == "jacoco" ]]; then
  REPORT_PATH="${2:-android/app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml}"
  if [[ ! -f "${REPORT_PATH}" ]]; then
    echo "coverage_gate: jacoco report not found at ${REPORT_PATH}" >&2
    exit 1
  fi
  read -r MISSED COVERED <<PYOUT
$(python3 - "${REPORT_PATH}" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
counters = [c for c in root.findall("counter") if c.get("type") == "LINE"]
if not counters:
    print("0 0")
else:
    counter = counters[0]
    print(f"{counter.get('missed')} {counter.get('covered')}")
PYEOF
)
PYOUT
  TOTAL=$((MISSED + COVERED))
  if [[ "${TOTAL}" -eq 0 ]]; then
    echo "coverage_gate: zero lines examined in ${REPORT_PATH} -- treating as FAILURE, not a pass" >&2
    exit 1
  fi
  PERCENT=$(python3 -c "print(f'{${COVERED} / ${TOTAL} * 100:.2f}')")
  echo "coverage_gate: ${TOTAL} lines examined (jacoco LINE counter), ${COVERED} covered"
else
  RAW_REPORT_PATH="${2:-coverage/lcov.info}"
  if [[ ! -f "${RAW_REPORT_PATH}" ]]; then
    echo "coverage_gate: lcov report not found at ${RAW_REPORT_PATH}" >&2
    exit 1
  fi

  FILTERED_REPORT="$(mktemp "${TMPDIR:-/tmp}/coverage_gate.filtered.XXXXXX")"
  COUNTS_FILE="$(mktemp "${TMPDIR:-/tmp}/coverage_gate.counts.XXXXXX")"
  trap 'rm -f "${FILTERED_REPORT}" "${COUNTS_FILE}"' EXIT

  filter_generated_lcov_records "${COUNTS_FILE}" < "${RAW_REPORT_PATH}" > "${FILTERED_REPORT}"
  read -r RAW_SF_COUNT EXCLUDED_SF_COUNT < "${COUNTS_FILE}"
  REPORT_PATH="${FILTERED_REPORT}"

  SF_COUNT=$(grep -c '^SF:' "${REPORT_PATH}" || :)   # grep -c prints 0 and exits 1 on no match; the zero is then rejected below
  echo "coverage_gate: excluded ${EXCLUDED_SF_COUNT} generated-file record(s) of ${RAW_SF_COUNT} total, ${SF_COUNT} remaining"
  if [[ "${SF_COUNT}" -eq 0 ]]; then
    echo "coverage_gate: zero SF (source file) records in ${RAW_REPORT_PATH} after excluding generated files -- treating as FAILURE, not a pass" >&2
    exit 1
  fi

  if [[ -n "${LIB_ROOT}" ]]; then
    if [[ ! -d "${LIB_ROOT}" ]]; then
      echo "coverage_gate: lib-root '${LIB_ROOT}' not found -- skipping on-disk completeness check" >&2
    else
      report_missing_coverage_records "${LIB_ROOT}" "${REPORT_PATH}" "${COMPLETENESS_ALLOWLIST}"
    fi
  fi

  LF_TOTAL=$(grep '^LF:' "${REPORT_PATH}" | awk -F: '{s+=$2} END {print s+0}')
  LH_TOTAL=$(grep '^LH:' "${REPORT_PATH}" | awk -F: '{s+=$2} END {print s+0}')
  if [[ "${LF_TOTAL}" -eq 0 ]]; then
    echo "coverage_gate: zero lines found (LF) across ${SF_COUNT} files in ${RAW_REPORT_PATH} -- treating as FAILURE, not a pass" >&2
    exit 1
  fi
  PERCENT=$(python3 -c "print(f'{${LH_TOTAL} / ${LF_TOTAL} * 100:.2f}')")
  echo "coverage_gate: ${SF_COUNT} files examined, ${LH_TOTAL}/${LF_TOTAL} lines covered"
fi

echo "coverage_gate: ${PERCENT}% (threshold ${THRESHOLD}%)"
awk -v p="${PERCENT}" -v t="${THRESHOLD}" 'BEGIN { exit !(p+0 >= t+0) }'
