#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="theDAW"
APP_DIR="${ROOT_DIR}/build/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
LAUNCHER_SOURCE="${ROOT_DIR}/scripts/macos/TheDAWLauncher.swift"
ICON_SOURCE="${ROOT_DIR}/frontend/public/favicon.svg"
ICON_NAME="theDAW.icns"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Missing required command: swiftc. Install Xcode Command Line Tools with: xcode-select --install"
  exit 1
fi

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

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
  <key>CFBundleIconFile</key>
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

create_icon() {
  if [[ ! -f "$ICON_SOURCE" ]]; then
    echo "Skipping app icon: missing ${ICON_SOURCE}"
    return
  fi

  local missing_command=""
  for required_command in qlmanage sips iconutil; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      missing_command="$required_command"
      break
    fi
  done

  if [[ -n "$missing_command" ]]; then
    echo "Skipping app icon: missing required command ${missing_command}"
    return
  fi

  local icon_work rendered_png iconset size scale pixels output_name
  icon_work="$(mktemp -d)"
  trap 'rm -rf "$icon_work"' RETURN

  qlmanage -t -s 1024 -o "$icon_work" "$ICON_SOURCE" >/dev/null 2>&1
  rendered_png="${icon_work}/$(basename "$ICON_SOURCE").png"
  if [[ ! -f "$rendered_png" ]]; then
    rendered_png="$(find "$icon_work" -maxdepth 1 -type f -name '*.png' | head -n 1)"
  fi

  if [[ -z "$rendered_png" || ! -f "$rendered_png" ]]; then
    echo "Skipping app icon: could not render ${ICON_SOURCE}"
    return
  fi

  iconset="${icon_work}/theDAW.iconset"
  mkdir -p "$iconset"

  for size in 16 32 128 256 512; do
    for scale in 1 2; do
      pixels=$((size * scale))
      if (( pixels > 1024 )); then
        continue
      fi

      if (( scale == 1 )); then
        output_name="icon_${size}x${size}.png"
      else
        output_name="icon_${size}x${size}@2x.png"
      fi

      sips -z "$pixels" "$pixels" "$rendered_png" --out "${iconset}/${output_name}" >/dev/null
    done
  done

  iconutil -c icns "$iconset" -o "${RESOURCES_DIR}/${ICON_NAME}"
}

create_icon

swiftc "$LAUNCHER_SOURCE" \
  -framework AppKit \
  -framework WebKit \
  -o "${MACOS_DIR}/${APP_NAME}"

chmod +x "${MACOS_DIR}/${APP_NAME}"
chmod +x "${ROOT_DIR}/start-dev.command"

echo "Created ${APP_DIR}"
