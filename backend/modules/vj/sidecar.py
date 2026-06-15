"""Manage the VJ Vite server as an SA3 sidecar.

The VJ project can live in an external ``GANTASMO-LIVE-VJ`` checkout
(overridable via ``theDAW_VJ_PROJECT``). If that checkout is not present,
we fall back to the small built-in VJ app at ``sidecars/vj``. It's a
vanilla Vite app — no Python, no heavy ML deps — so the spawn logic is
much simpler than the stems sidecar.

By default the sidecar serves a production build (``vite preview`` over
``dist/``): no HMR websocket, no per-request transforms, no file watcher
— measurably lighter than the dev server during performance use.
``dist/`` is rebuilt automatically when missing or older than the newest
source file. Set ``theDAW_VJ_DEV=1`` to force the dev server while working
on the VJ app itself.

We deliberately use a NON-default port (5187) because:
  * 3000 (React default) is the user's explicit "don't use this"
    request — they've had too many collisions.
  * 5173 is the SA3 frontend's port.
  * 5174 is Vite's next-port fallback (so SA3 frontend often grabs it
    when 5173 is taken).
  * 5187 is far enough from those that it stays out of the way.

The port is configurable via ``theDAW_VJ_PORT``.

Lifecycle:
  * ``probe()`` — does the project exist? Does package.json look right?
    Is the port currently listening?
  * ``ensure_running()`` — lazy spawn. Returns the live URL once the
    dev server is ready, or raises RuntimeError with a diagnostic.
  * ``stop()`` — terminates the subprocess.
  * The FastAPI startup hook in router.py calls ensure_running() in
    the background so the VJ server is warm by the time the user
    clicks the VJ tab.
"""

from __future__ import annotations

import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Optional

log = logging.getLogger(__name__)


REPO_ROOT = Path(__file__).resolve().parents[3]
BUILTIN_PROJECT_PATH = REPO_ROOT / "sidecars" / "vj"
LEGACY_PROJECT_PATH = Path(r"D:/StableAudio/GANTASMO-LIVE-VJ")
DEFAULT_PORT = 5187
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5
BUILD_TIMEOUT_SEC = 300.0

# Inputs to the staleness check: the newest mtime across these (files
# directly, directories recursively) is compared against dist/index.html,
# which vite rewrites on every build.
_SOURCE_DIRS = ("src", "assets", "public")
_SOURCE_FILES = (
    "index.html",
    "vite.config.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
)


@dataclass
class VJConfig:
    project_path: Path
    port: int
    npm_path: str
    dev_mode: bool
    project_source: str


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None


def _project_candidates() -> list[tuple[Path, str]]:
    """Likely VJ project locations, ordered from portable to legacy."""
    return [
        (BUILTIN_PROJECT_PATH, "built-in sidecar"),
        (REPO_ROOT.parent / "GANTASMO-LIVE-VJ", "adjacent checkout"),
        (REPO_ROOT.parent.parent / "GANTASMO-LIVE-VJ", "Documents checkout"),
        (Path.home() / "Documents" / "GANTASMO-LIVE-VJ", "Documents checkout"),
        (LEGACY_PROJECT_PATH, "legacy Windows path"),
    ]


def _resolve_project_path() -> tuple[Path, str]:
    env_path = os.getenv("theDAW_VJ_PROJECT")
    if env_path:
        return Path(env_path).expanduser().resolve(), "theDAW_VJ_PROJECT"

    for candidate, source in _project_candidates():
        if (candidate / "package.json").is_file():
            return candidate.resolve(), source

    # Return the portable built-in path even if it is incomplete so the
    # frontend diagnostic points at the checkout-local project, not D:\.
    return BUILTIN_PROJECT_PATH.resolve(), "built-in sidecar"


def resolve_config() -> VJConfig:
    """Resolve project path + port + the npm binary to use."""
    project_path, project_source = _resolve_project_path()

    port_env = os.getenv("theDAW_VJ_PORT")
    try:
        port = int(port_env) if port_env else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    # On Windows the executable is npm.cmd; shutil.which handles the
    # shim resolution. Fall back to a bare 'npm' so the error message
    # at spawn time is informative ("npm not found") rather than a
    # generic FileNotFoundError.
    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"

    dev_mode = os.getenv("theDAW_VJ_DEV") == "1"

    return VJConfig(
        project_path=project_path,
        port=port,
        npm_path=npm_path,
        dev_mode=dev_mode,
        project_source=project_source,
    )


def _newest_source_mtime(root: Path) -> float:
    newest = 0.0
    for name in _SOURCE_FILES:
        f = root / name
        if f.is_file():
            newest = max(newest, f.stat().st_mtime)
    for name in _SOURCE_DIRS:
        d = root / name
        if d.is_dir():
            for p in d.rglob("*"):
                if p.is_file():
                    newest = max(newest, p.stat().st_mtime)
    return newest


def _build_is_stale(root: Path) -> bool:
    """True when dist/ is missing or older than the newest source file."""
    marker = root / "dist" / "index.html"
    if not marker.is_file():
        return True
    return _newest_source_mtime(root) > marker.stat().st_mtime


def _ensure_build(cfg: VJConfig) -> None:
    """Run ``npm run build`` when dist/ is missing or stale. Raises
    RuntimeError with the build log tail on failure."""
    if not _build_is_stale(cfg.project_path):
        return
    log.info("vj.sidecar: dist/ missing or stale — running npm run build")
    try:
        proc = subprocess.run(
            [cfg.npm_path, "run", "build"],
            cwd=str(cfg.project_path),
            capture_output=True,
            timeout=BUILD_TIMEOUT_SEC,
            shell=False,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"VJ sidecar: npm not found ({e}). Install Node.js.") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"VJ build timed out after {int(BUILD_TIMEOUT_SEC)}s in {cfg.project_path}."
        ) from e
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace")[-2000:]
        raise RuntimeError(
            f"VJ build failed (rc={proc.returncode}) in {cfg.project_path}:\n{tail}"
        )
    log.info("vj.sidecar: build complete")


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on ``host:port`` — used
    both for readiness polls and for detecting an existing VJ instance
    we shouldn't double-spawn."""
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def detect_lan_ip() -> Optional[str]:
    """Best-effort detection of this machine's primary LAN IPv4 address
    so phones/tablets on the same network can reach the VJ output.

    We open a UDP socket "toward" a public address (no packets are
    actually sent for UDP connect) and read back the local end of the
    route the OS picked. This reliably yields the interface IP used for
    outbound LAN/WAN traffic, dodging the 127.0.0.1 that
    ``socket.gethostbyname(gethostname())`` often returns. Returns None
    if we can't determine a non-loopback address.
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 8.8.8.8 is just a routing hint; nothing is transmitted.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        if s is not None:
            try:
                s.close()
            except OSError:
                pass
    if ip and not ip.startswith("127."):
        return ip
    return None


def mobile_url_for(port: int) -> Optional[str]:
    """Return a LAN-reachable URL for the given port, or None if no
    non-loopback IP could be detected (e.g. machine is offline)."""
    ip = detect_lan_ip()
    return f"http://{ip}:{port}" if ip else None


def probe() -> dict:
    """Non-spawning diagnostics for the Settings UI / /status endpoint."""
    cfg = resolve_config()
    pkg = cfg.project_path
    pkg_json = pkg / "package.json"
    issues: list[str] = []
    if not pkg.is_dir():
        issues.append(f"project path does not exist: {pkg}")
    elif not pkg_json.is_file():
        issues.append(f"no package.json at {pkg_json}")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        issues.append("npm not found on PATH — install Node.js first")
    listening = _port_is_listening(cfg.port)
    return {
        "project_path": str(pkg),
        "project_source": cfg.project_source,
        "port": cfg.port,
        # "preview" = production build via `vite preview` (default);
        # "dev" = HMR dev server (theDAW_VJ_DEV=1).
        "mode": "dev" if cfg.dev_mode else "preview",
        "build_stale": _build_is_stale(pkg) if pkg.is_dir() else None,
        "listening": listening,
        "process_alive": _proc is not None and _proc.poll() is None,
        "url": _resolved_url or f"http://localhost:{cfg.port}",
        # LAN-reachable URL for phones/tablets (None if offline). The
        # Vite server is bound to 0.0.0.0 so mobile devices on the same
        # network can reach it.
        "mobile_url": mobile_url_for(cfg.port),
        "lan_ip": detect_lan_ip(),
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the VJ Vite server (preview by default, dev with
    theDAW_VJ_DEV=1) if it isn't already, and return the URL it serves
    on. Safe to call repeatedly — no-ops if the port is already
    listening, even if some OTHER process started the server."""
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"

        # Already listening (either our subprocess or one the user
        # launched manually) — just return the URL.
        if _port_is_listening(cfg.port):
            _resolved_url = url
            return url

        if _proc is not None and _proc.poll() is None:
            # We have a live child but it's not yet listening; fall
            # through to the wait-for-ready loop below.
            pass
        else:
            # No live child — spawn one.
            if not cfg.project_path.is_dir():
                raise RuntimeError(
                    f"VJ project not found at {cfg.project_path}. Set "
                    "theDAW_VJ_PROJECT to override, or restore the built-in "
                    "sidecars/vj project."
                )
            if not (cfg.project_path / "package.json").is_file():
                raise RuntimeError(
                    f"VJ project at {cfg.project_path} has no package.json. "
                    "Set theDAW_VJ_PROJECT to a Vite app or restore sidecars/vj."
                )
            # First-run bootstrap: if node_modules is missing, npm run
            # dev exits with rc=1 immediately ("vite: not found"). Do
            # an `npm install` first. This can take a couple of minutes
            # on a fresh checkout — the readiness deadline below is
            # generous enough to cover it, and the frontend's VJView
            # already shows a "first launch can take a minute" hint.
            node_modules = cfg.project_path / "node_modules"
            if not node_modules.is_dir():
                log.info("vj.sidecar: node_modules missing — running npm install")
                install_cmd = [cfg.npm_path, "install"]
                try:
                    rc = subprocess.call(
                        install_cmd,
                        cwd=str(cfg.project_path),
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        shell=False,
                    )
                except FileNotFoundError as e:
                    raise RuntimeError(
                        f"VJ sidecar: npm not found ({e}). Install Node.js."
                    ) from e
                if rc != 0:
                    raise RuntimeError(
                        f"npm install failed in {cfg.project_path} (rc={rc}). "
                        "Run it manually to see the full error output, then retry."
                    )
                log.info("vj.sidecar: npm install complete")
            if cfg.dev_mode:
                cmd = [
                    cfg.npm_path,
                    "run",
                    "dev",
                    "--",
                    "--host",
                    "0.0.0.0",
                    "--port",
                    str(cfg.port),
                    "--strictPort",
                ]
            else:
                # Production serve: build once (when stale), then `vite
                # preview` over dist/ — same port contract and SPA
                # behavior as the dev server, none of its per-request
                # work. `--host` (bare) binds 0.0.0.0 so the LAN/mobile
                # URL keeps working; allowedHosts is inherited from the
                # project's server config.
                _ensure_build(cfg)
                cmd = [
                    cfg.npm_path,
                    "run",
                    "preview",
                    "--",
                    "--port",
                    str(cfg.port),
                    "--strictPort",
                    "--host",
                ]
            log.info(
                "vj.sidecar: spawning %s (cwd=%s)",
                " ".join(cmd),
                cfg.project_path,
            )
            try:
                # On Windows, npm is a .cmd shim; CREATE_NO_WINDOW
                # keeps the spawn quiet inside the SA3 backend console
                # instead of popping a separate cmd window. We capture
                # stdout/stderr so they merge into the backend log.
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
                _proc = subprocess.Popen(
                    cmd,
                    cwd=str(cfg.project_path),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=creationflags,
                    shell=False,
                )
            except FileNotFoundError as e:
                raise RuntimeError(
                    f"Failed to launch VJ sidecar: {e}. Is npm on PATH?"
                ) from e

        if not wait_for_ready:
            _resolved_url = url
            return url

        deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if _port_is_listening(cfg.port):
                _resolved_url = url
                log.info("vj.sidecar: ready at %s", url)
                return url
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    "VJ sidecar exited before becoming ready (rc="
                    f"{_proc.returncode}). Check the project's "
                    "package.json scripts (preview/dev)."
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)
        raise RuntimeError(
            f"VJ sidecar didn't open port {cfg.port} within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s — likely a npm-install "
            "or vite startup hang."
        )


def stop() -> bool:
    """Terminate the sidecar if we spawned it. Returns True if we
    actually stopped a live process."""
    global _proc, _resolved_url
    with _state_lock:
        if _proc is None:
            return False
        if _proc.poll() is not None:
            _proc = None
            return False
        try:
            if sys.platform == "win32":
                # npm.cmd is a shim: terminate() kills the cmd wrapper
                # and leaves the node (vite) child listening. Kill the
                # whole tree.
                subprocess.call(
                    ["taskkill", "/PID", str(_proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                _proc.wait(timeout=5.0)
            else:
                _proc.terminate()
                _proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            _proc.kill()
        finally:
            _proc = None
            _resolved_url = None
        return True
