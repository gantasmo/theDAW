"""Native Kinect sidecar manager for the akvj module.

Owns the lifecycle of ``kinect_sidecar.py`` — a headless pyk4a capture process
that opens the Azure Kinect directly and streams a one-time XY unprojection table
plus per-frame depth16 + depth-aligned color to the akvj relay's ``/ws/source``.
The VJ ``akvj3d`` source then renders the point cloud natively in three.js, so no
Unity is needed in the default path.

This module is just process lifecycle + diagnostics, mirroring the questcast
sidecar: it bootstraps the capture deps on first run (pyk4a-bundle ships its own
matched k4a/depthengine DLLs, so nothing else has to be installed), spawns the
script with ``sys.executable``, and parses its structured stdout so the API can
report device/streaming/error state and a rolling log.

Windows x64 and Linux x64 only (the Azure Kinect SDK native stack; pyk4a-bundle
publishes no macOS wheel).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

LOG_RING_SIZE = 400
SCRIPT = Path(__file__).resolve().parent / "kinect_sidecar.py"
BOOTSTRAP_TIMEOUT_SEC = 600.0
READY_TIMEOUT_SEC = 30.0

# Capture deps. pyk4a-bundle carries its OWN matched k4a.dll + depthengine, so the
# user installs nothing else. numpy/websockets ship with the backend already;
# pillow encodes the colour frames to JPEG.
PIP_PACKAGES = ["pyk4a-bundle", "websockets", "numpy", "pillow"]
IMPORT_PROBE = "import pyk4a, numpy, websockets, PIL"

# Sidecar stdout status values that describe its lifecycle; the manager mirrors
# each one into its reported state so the UI can show the real progression rather
# than a single opaque "starting".
LIFECYCLE_STATES = {
    "opening",
    "opened",
    "device",
    "building_table",
    "table_packed",
    "table_ready",
    "connecting",
    "relay_connected",
    "streaming",
    "error",
}


def _default_ws_url() -> str:
    explicit = os.getenv("theDAW_AKVJ_WS_URL")
    if explicit:
        return explicit
    port = os.getenv("theDAW_PORT") or os.getenv("PORT") or "8600"
    return f"ws://127.0.0.1:{port}/api/akvj/ws/source"


class AkvjSidecar:
    """One instance per process. ``start()`` is idempotent."""

    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._status: dict[str, Any] = {"state": "stopped"}
        self._log: deque[str] = deque(maxlen=LOG_RING_SIZE)

    def _record(self, line: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self._log.append(f"{stamp} {line}")
        log.info("akvj-sidecar: %s", line)

    # ---- diagnostics --------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self.running,
                "platform": sys.platform,
                "supported": sys.platform in ("win32", "linux"),
                "python": sys.executable,
                "script": str(SCRIPT),
                "script_present": SCRIPT.is_file(),
                "deps_installed": self._deps_present(),
                "log": list(self._log),
                **self._status,
            }

    # ---- bootstrap ----------------------------------------------------------

    def _deps_present(self) -> bool:
        try:
            r = subprocess.run(
                [sys.executable, "-c", IMPORT_PROBE],
                capture_output=True,
                timeout=30,
            )
            return r.returncode == 0
        except (subprocess.TimeoutExpired, OSError):
            return False

    def _ensure_deps(self) -> Optional[str]:
        if self._deps_present():
            return None
        self._record("installing Kinect capture deps (one-time)...")
        # Prefer uv (the project's resolver); fall back to pip in the venv.
        attempts = [
            ["uv", "pip", "install", *PIP_PACKAGES],
            [sys.executable, "-m", "pip", "install", *PIP_PACKAGES],
        ]
        last_err = ""
        for cmd in attempts:
            try:
                r = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=BOOTSTRAP_TIMEOUT_SEC,
                )
            except (subprocess.TimeoutExpired, OSError) as e:
                last_err = f"{cmd[0]}: {e}"
                continue
            if r.returncode == 0 and self._deps_present():
                self._record(f"deps installed via {cmd[0]}")
                return None
            last_err = (r.stderr or r.stdout or "")[-400:]
            self._record(f"{cmd[0]} install failed: {last_err}")
        return f"could not install Kinect capture deps: {last_err}"

    # ---- lifecycle ----------------------------------------------------------

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                with self._lock:
                    self._record(f"[sidecar raw] {line}")
                continue
            status = msg.get("status")
            with self._lock:
                detail = {k: v for k, v in msg.items() if k != "status"}
                self._record(
                    f"[sidecar] {status}"
                    + (f" {json.dumps(detail, default=str)}" if detail else "")
                )
                if status in LIFECYCLE_STATES:
                    self._status = {"state": status, **msg}
        with self._lock:
            rc = proc.poll()
            self._record(f"[sidecar] process exited (rc={rc})")
            if self._status.get("state") not in ("error", "stopped"):
                self._status = {"state": "stopped", "reason": f"exited (rc={rc})"}

    def start(self, overrides: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        overrides = overrides or {}
        with self._lock:
            if self.running:
                self._record("start() ignored, sidecar already running")
                return self.status()

            if sys.platform not in ("win32", "linux"):
                msg = (
                    f"the native Kinect sidecar needs Windows or Linux x64 "
                    f"(this is {sys.platform}). Run the Unity Akvj path instead, "
                    f"or point at a remote Kinect PC."
                )
                self._status = {"state": "error", "message": msg}
                self._record(f"ABORT: {msg}")
                return {"ok": False, "error": msg}

            if not SCRIPT.is_file():
                msg = f"capture script missing: {SCRIPT}"
                self._status = {"state": "error", "message": msg}
                self._record(f"ABORT: {msg}")
                return {"ok": False, "error": msg}

            self._record("ensuring capture deps...")
            err = self._ensure_deps()
            if err:
                self._status = {"state": "error", "message": err}
                self._record(f"ABORT: {err}")
                return {"ok": False, "error": err}

            env = dict(os.environ)
            env["AKVJ_WS_URL"] = str(overrides.get("ws_url") or _default_ws_url())
            if overrides.get("fps"):
                env["AKVJ_FPS"] = str(overrides["fps"])
            if overrides.get("color_quality"):
                env["AKVJ_COLOR_QUALITY"] = str(overrides["color_quality"])

            self._status = {"state": "starting"}
            self._record(f"spawning sidecar: {SCRIPT.name} -> {env['AKVJ_WS_URL']}")
            try:
                self._proc = subprocess.Popen(
                    [sys.executable, "-u", str(SCRIPT)],
                    cwd=str(SCRIPT.parent),
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
            except OSError as e:
                self._status = {"state": "error", "message": str(e)}
                self._record(f"ABORT: spawn failed: {e}")
                return {"ok": False, "error": str(e)}

            self._record(f"sidecar process started (pid={self._proc.pid})")
            self._reader = threading.Thread(
                target=self._read_stdout, args=(self._proc,), daemon=True
            )
            self._reader.start()

        deadline = time.monotonic() + READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if not self.running:
                break
            with self._lock:
                state = self._status.get("state")
            if state in ("streaming", "error"):
                break
            time.sleep(0.25)
        return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lock:
            proc = self._proc
            self._proc = None
            self._status = {"state": "stopped"}
            self._record("stop() requested, terminating sidecar")
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return {"ok": True, "state": "stopped"}


_sidecar: Optional[AkvjSidecar] = None


def get_sidecar() -> AkvjSidecar:
    global _sidecar
    if _sidecar is None:
        _sidecar = AkvjSidecar()
    return _sidecar
