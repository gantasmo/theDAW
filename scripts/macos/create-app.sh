#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="theDAW"
APP_DIR="${ROOT_DIR}/build/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
LAUNCHER_SOURCE="${ROOT_DIR}/scripts/macos/TheDAWLauncher.swift"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Missing required command: swiftc. Install Xcode Command Line Tools with: xcode-select --install"
  exit 1
fi

mkdir -p "$MACOS_DIR"

cat > "${CONTENTS_DIR}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>theDAW</string>
  <key>CFBundleDisplayName</key>
  <string>theDAW</string>
  <key>CFBundleIdentifier</key>
  <string>com.gantasmo.thedaw.local</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>theDAW</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

/usr/libexec/PlistBuddy \
  -c "Add :StableDAWRepositoryPath string ${ROOT_DIR}" \
  "${CONTENTS_DIR}/Info.plist"

swiftc "$LAUNCHER_SOURCE" \
  -framework AppKit \
  -framework WebKit \
  -o "${MACOS_DIR}/${APP_NAME}"

chmod +x "${MACOS_DIR}/${APP_NAME}"
chmod +x "${ROOT_DIR}/start-dev.command"

echo "Created ${APP_DIR}"
