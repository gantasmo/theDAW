#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="theDAW"
APP_DIR="${ROOT_DIR}/build/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

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
</dict>
</plist>
PLIST

quoted_root="$(shell_quote "$ROOT_DIR")"
cat > "${MACOS_DIR}/${APP_NAME}" <<APP
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=${quoted_root}
cd "\$REPO_DIR"

osascript <<OSA
tell application "Terminal"
  activate
  do script "cd ${quoted_root}; ./start-dev.command"
end tell
OSA
APP

chmod +x "${MACOS_DIR}/${APP_NAME}"
chmod +x "${ROOT_DIR}/start-dev.command"

echo "Created ${APP_DIR}"
