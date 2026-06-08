#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
APP_PATH="${BUILD_DIR}/theDAW.app"
DMG_PATH="${BUILD_DIR}/theDAW.dmg"
STAGING_DIR="${BUILD_DIR}/dmg-staging"
VOL_NAME="theDAW"

if [[ ! -d "$APP_PATH" ]]; then
  "${ROOT_DIR}/scripts/macos/create-app.sh"
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

ditto "$APP_PATH" "${STAGING_DIR}/theDAW.app"
ln -s /Applications "${STAGING_DIR}/Applications"

rm -f "$DMG_PATH"
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

rm -rf "$STAGING_DIR"

echo "Created ${DMG_PATH}"
