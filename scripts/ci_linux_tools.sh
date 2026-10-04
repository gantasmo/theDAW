#!/usr/bin/env bash
# The tools the `pytest` job's runner has and a fresh WSL Ubuntu lacks, put in
# place before scripts/ci_linux.sh runs the suite:
#
#   ffmpeg, ffprobe  the workflow apt-installs them; the chimera, stretch,
#                    float-audio and mastering tests call them
#   node, npm        the runner ships them; the UNDERFIT assistant sidecar
#                    tests start a Node server
#
# Each missing one is installed under ~/.local with no sudo, at its newest
# release: ffmpeg from the BtbN static builds (the highest nX.Y release), Node
# at the newest LTS from nodejs.org. Exit 2 when a download or unpack fails.
#
# ci_linux.sh removes the Windows interop entries (/mnt/...) from PATH first,
# so a Windows node.exe on PATH never stands in for a Linux one.
set -u

prefix="$HOME/.local"
bin="$prefix/bin"
mkdir -p "$bin"

have() { command -v "$1" >/dev/null 2>&1; }
fetch() { curl -fsSL --retry 3 --retry-delay 2 "$1" -o "$2"; }

if ! have ffmpeg || ! have ffprobe; then
  url="$(curl -fsSL https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest | python3 -c '
import json, re, sys
assets = json.load(sys.stdin).get("assets", [])
best = None
for a in assets:
    m = re.fullmatch(r"ffmpeg-n(\d+)\.(\d+)-latest-linux64-gpl-[\d.]+\.tar\.xz", a["name"])
    if m and (best is None or (int(m[1]), int(m[2])) > best[0]):
        best = ((int(m[1]), int(m[2])), a["browser_download_url"])
print(best[1] if best else "")
')"
  if [ -z "$url" ]; then
    echo "ci_linux: no ffmpeg release build was listed" >&2
    exit 2
  fi
  echo "ci_linux: installing ffmpeg and ffprobe into $bin from $url"
  tmp="$(mktemp -d)"
  if ! fetch "$url" "$tmp/ffmpeg.tar.xz" || ! tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp"; then
    rm -rf "$tmp"
    echo "ci_linux: the ffmpeg download failed" >&2
    exit 2
  fi
  cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$bin/"
  rm -rf "$tmp"
fi

if ! have node || ! have npm; then
  version="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c '
import json, sys
print(next((r["version"] for r in json.load(sys.stdin) if r["lts"]), ""))
')"
  if [ -z "$version" ]; then
    echo "ci_linux: nodejs.org listed no LTS release" >&2
    exit 2
  fi
  echo "ci_linux: installing Node $version into $prefix"
  tmp="$(mktemp -d)"
  if ! fetch "https://nodejs.org/dist/$version/node-$version-linux-x64.tar.xz" "$tmp/node.tar.xz" \
    || ! tar -xJf "$tmp/node.tar.xz" -C "$prefix"; then
    rm -rf "$tmp"
    echo "ci_linux: the Node download failed" >&2
    exit 2
  fi
  rm -rf "$tmp"
  for tool in node npm npx; do
    ln -sf "$prefix/node-$version-linux-x64/bin/$tool" "$bin/$tool"
  done
fi

echo "ci_linux: $(ffmpeg -version | head -n 1 | cut -d' ' -f1-3), node $(node --version), npm $(npm --version)"
