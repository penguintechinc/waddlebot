#!/usr/bin/env bash
# Runs on the HOST (not in the container - the toolchain container only
# mounts mobile/gazer/, not the repo root, so it cannot write into
# docs/screenshots/ itself). Copies the fixed-name marketing screenshot
# set from mobile/gazer/build/integration_screenshots/ into
# docs/screenshots/gazer/ at the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC_DIR="$REPO_ROOT/mobile/gazer/build/integration_screenshots"
DEST_DIR="$REPO_ROOT/docs/screenshots/gazer"

# Five distinct screens, not five files. Ruling R42 replaced
# "status-panel-tablet" with "settings-tablet": the former was the same
# rendered screen as "home-tablet" (the status panel is already the
# persistent right pane at >=600dp), so it shipped a duplicate under a
# name implying a view that does not exist.
NAMES=(
  "home-idle-phone"
  "settings-phone"
  "status-panel-phone"
  "home-tablet"
  "settings-tablet"
)

mkdir -p "$DEST_DIR"

copied=0
for name in "${NAMES[@]}"; do
  src="$SRC_DIR/$name.png"
  if [ ! -f "$src" ]; then
    echo "ERROR: expected screenshot missing: $src" >&2
    exit 1
  fi
  if [ ! -s "$src" ]; then
    echo "ERROR: expected screenshot is empty (0 bytes): $src" >&2
    exit 1
  fi
  cp "$src" "$DEST_DIR/$name.png"
  copied=$((copied + 1))
done

if [ "$copied" -ne "${#NAMES[@]}" ]; then
  echo "ERROR: copied $copied of ${#NAMES[@]} expected screenshots" >&2
  exit 1
fi

echo "copied $copied/${#NAMES[@]} screenshots into $DEST_DIR"
