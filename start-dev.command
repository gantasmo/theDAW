#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

BACKEND_PORT="8600"
FRONTEND_PORT="5173"
VJ_PORT="5187"
APP_URL="http://localhost:${FRONTEND_PORT}"

BACKEND_PID=""
FRONTEND_PID=""
TUNNEL_PID=""

log() {
  printf '[theDAW] %s\n' "$*"
}

require_cmd() {
  local name="$1"
  local install_hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    log "Missing required command: ${name}"
    log "${install_hint}"
    exit 1
  fi
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  log "Stopping stale process(es) on port ${port}: ${pids//$'\n'/ }"
  kill $pids 2>/dev/null || true
  sleep 1

  pids="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill -9 $pids 2>/dev/null || true
  fi
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local seconds="${3:-60}"

  for _ in $(seq 1 "$seconds"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "${label} is ready."
      return 0
    fi
    sleep 1
  done

  log "${label} did not respond within ${seconds}s."
  return 1
}

cleanup() {
  log "Shutting down..."
  for pid in "$TUNNEL_PID" "$FRONTEND_PID" "$BACKEND_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

log "Starting macOS development launcher."
require_cmd uv "Install uv from https://docs.astral.sh/uv/ or run: brew install uv"
require_cmd node "Install Node.js, for example: brew install node"
require_cmd npm "Install npm with Node.js, for example: brew install node"
require_cmd ffmpeg "Install FFmpeg, preferably with librubberband: brew install ffmpeg"
require_cmd ffprobe "Install FFmpeg, preferably with librubberband: brew install ffmpeg"

log "Cleaning up stale server ports."
kill_port "$FRONTEND_PORT"
kill_port "$BACKEND_PORT"
kill_port "$VJ_PORT"

if [[ ! -d ".venv" ]]; then
  log "Creating Python environment with uv. This can take a while the first time."
  uv sync
else
  log "Python environment already exists; syncing in case dependencies changed."
  uv sync
fi

if [[ ! -d "frontend/node_modules" ]]; then
  log "Installing frontend dependencies."
  (cd frontend && npm install)
fi

log "Starting backend API on port ${BACKEND_PORT}."
SA3_SUPERVISOR_PRESENT=1 uv run python -m backend._supervisor &
BACKEND_PID="$!"

wait_for_url "http://localhost:${BACKEND_PORT}/api/health" "Backend" 90 || true

log "Starting frontend UI on port ${FRONTEND_PORT}."
(cd frontend && npm run dev) &
FRONTEND_PID="$!"

wait_for_url "$APP_URL" "Frontend" 60 || true

if [[ "${START_TUNNEL:-false}" == "true" ]]; then
  if command -v lt >/dev/null 2>&1; then
    log "Starting localtunnel for public sharing."
    lt --port "$FRONTEND_PORT" --subdomain "${SA3_TUNNEL_SUBDOMAIN:-stabledaw}" --print-requests &
    TUNNEL_PID="$!"
  else
    log "START_TUNNEL=true, but localtunnel is not installed. Run: npm install -g localtunnel"
  fi
fi

log "Opening ${APP_URL}"
open "$APP_URL"

log "Servers are running. Close this Terminal window or press Ctrl-C to stop them."
wait
