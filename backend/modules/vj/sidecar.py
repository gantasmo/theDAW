"""Manage the GANTASMO-LIVE-VJ Vite server as an SA3 sidecar.

The VJ project is its own repo (``gantasmo/VJ-9000``), discovered
relative to the app or overridable via ``theDAW_VJ_PROJECT``. It's a
vanilla Vite/React SPA — no Python, no heavy ML deps, no server
component — so the compiled ``dist/`` IS the whole app.

DEFAULT (static mode): whenever a build is resolvable, the theDAW
BACKEND serves ``dist/`` itself as a StaticFiles mount at
``/vj-app`` (see ``server.py``) and spawns NO Node process. This
removes the runtime Node.js requirement on end-user machines and
makes the VJ tab behave identically on Windows, macOS, Linux, and
Docker. ``resolve_dist_dir()`` / ``is_static_mode()`` / the
``STATIC_MOUNT_PATH`` constant drive that path; a dist can come from
``theDAW_VJ_DIST``, the resolved checkout's ``dist/``, or a release
bundle beside the app. When the resolved project is a full source
checkout with npm present, ``ensure_static_dist()`` refreshes a stale
build first so dev checkouts stay current.

DEV mode (``theDAW_VJ_DEV=1``): the legacy path — spawn the Vite dev
server (HMR) and poll the port — for working ON the VJ app itself.

The dev/preview server (dev mode only) deliberately uses a NON-default
port (5187) because:
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
  * Warm-up is request-driven: router.py's ``_maybe_auto_spawn`` kicks a
    one-time background readiness thread on the first /url, /mobile, or
    /status call (there is no FastAPI startup hook).
"""

from __future__ import annotations

import http.client
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import IO, Iterator, Optional
from backend.lib import paths
from backend.lib.fswalk import walk_files
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)


# Repo root (…/stable-audio-3): backend/modules/vj/sidecar.py -> parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _vj_project_candidates() -> list[Path]:
    """Portable search order for the VJ project when theDAW_VJ_PROJECT is
    unset. Ordered from "bundled/checked-out inside the app" to
    "dev-checkout sibling of this repo". Nothing here is machine-specific:
    every entry is derived from this file's location, so it resolves the
    same on any install. The first candidate whose package.json exists
    wins; if none do, the first entry is used so diagnostics name a path
    local to THIS install rather than one from the build machine."""
    # Both the local dev name (GANTASMO-LIVE-VJ) and the repo name a fresh
    # `git clone` produces (VJ-9000) are searched, so a plain clone beside the
    # repo works with no env var on any machine.
    return [
        _REPO_ROOT / "vj",  # bundled checkout inside the app (release layout)
        _REPO_ROOT.parent / "GANTASMO-LIVE-VJ",  # sibling of the repo
        _REPO_ROOT.parent / "VJ-9000",  # sibling, fresh-clone name
        _REPO_ROOT.parent.parent / "GANTASMO-LIVE-VJ",  # nested dev layout
        _REPO_ROOT.parent.parent / "VJ-9000",  # nested dev, fresh-clone name
    ]


def _default_project_path() -> Path:
    candidates = _vj_project_candidates()
    for c in candidates:
        if (c / "package.json").is_file():
            return c
    return candidates[0]


DEFAULT_PROJECT_PATH = _default_project_path()
DEFAULT_PORT = 5187
PORT_READY_TIMEOUT_SEC = 60.0
PORT_POLL_INTERVAL_SEC = 0.5
BUILD_TIMEOUT_SEC = 300.0
NPM_INSTALL_TIMEOUT_SEC = 600.0

# Child-process output (npm install, vite dev/preview) lands here so failures
# are diagnosable; previously it went to DEVNULL and a server that died before
# ready reported only "exited (rc=1)" with no cause anywhere.
SIDECAR_LOG_PATH = paths.data_path("logs", "vj-sidecar.log")


def _npm_install_env() -> dict[str, str]:
    """The environment ``npm install`` runs in for the VJ checkout.

    sharp, a VJ-9000 dependency, skips its prebuilt binary and builds from
    source whenever pkg-config finds a system libvips, which a Linux desktop
    often has. That build stops at a missing node-addon-api and fails the whole
    install (gantasmo/theDAW-Pinokio#5). SHARP_IGNORE_GLOBAL_LIBVIPS makes
    sharp skip the search and take the prebuilt binary; the Pinokio launcher
    sets it for its own VJ install. Someone who set SHARP_FORCE_GLOBAL_LIBVIPS
    asked for the system library, and sharp reads IGNORE first, so nothing is
    added then."""
    env = child_env()
    if not env.get("SHARP_FORCE_GLOBAL_LIBVIPS"):
        env.setdefault("SHARP_IGNORE_GLOBAL_LIBVIPS", "1")
    return env


@contextmanager
def _sidecar_log_handle() -> Iterator[IO[bytes] | int]:
    """Yield a child-stdout target: the sidecar log file, or DEVNULL when the
    file can't be opened (read-only disk). Closes the parent's handle on
    exit; a spawned child keeps its inherited copy."""
    handle: IO[bytes] | int = subprocess.DEVNULL
    try:
        SIDECAR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        handle = open(SIDECAR_LOG_PATH, "ab")
    except OSError:
        handle = subprocess.DEVNULL
    try:
        yield handle
    finally:
        if not isinstance(handle, int):
            try:
                handle.close()
            except OSError:
                pass


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
    node_path: str
    dev_mode: bool


_state_lock = Lock()
_proc: Optional[subprocess.Popen[bytes]] = None
_resolved_url: Optional[str] = None


# A vite server started with `--port 0` doesn't get an OS-assigned free
# port the way a raw socket bind(0) would -- vite treats 0 as falsy and
# falls back to its own default (5173), which collides with the SA3
# frontend's own dev server port (see resolve_config()'s validation).
_MIN_TCP_PORT = 1
_MAX_TCP_PORT = 65535


def resolve_config() -> VJConfig:
    """Resolve project path + port + the npm/node binaries to use.

    ``theDAW_VJ_PORT`` is validated, never passed straight through to the
    spawned vite argv: an unparsable value, port 3000 (banned on this
    machine), or anything outside the valid TCP port range 1-65535
    (``--port 0`` isn't "OS-assigned" for vite the way a raw socket bind(0)
    is -- vite treats 0 as falsy and falls back to its own default, 5173,
    which collides with the SA3 frontend's own dev server) all degrade to
    ``DEFAULT_PORT`` with a ``log.warning`` -- the same degrade-and-log
    shape for every kind of bad input, consistent with how a malformed
    integer already fell back silently here; a warning was added to make
    all three cases equally diagnosable instead of only the new ones."""
    pkg = os.getenv("theDAW_VJ_PROJECT")
    project_path = Path(pkg).expanduser().resolve() if pkg else DEFAULT_PROJECT_PATH

    port_env = os.getenv("theDAW_VJ_PORT")
    port = DEFAULT_PORT
    if port_env:
        try:
            candidate = int(port_env.strip())
        except ValueError:
            log.warning(
                "vj.sidecar: theDAW_VJ_PORT=%r is not a valid integer -- "
                "using the default port %d instead.",
                port_env,
                DEFAULT_PORT,
            )
        else:
            if candidate == 3000:
                log.warning(
                    "vj.sidecar: theDAW_VJ_PORT=3000 is banned on this "
                    "machine -- using the default port %d instead.",
                    DEFAULT_PORT,
                )
            elif not (_MIN_TCP_PORT <= candidate <= _MAX_TCP_PORT):
                log.warning(
                    "vj.sidecar: theDAW_VJ_PORT=%d is outside the valid TCP "
                    "port range (%d-%d) -- using the default port %d "
                    "instead.",
                    candidate,
                    _MIN_TCP_PORT,
                    _MAX_TCP_PORT,
                    DEFAULT_PORT,
                )
            else:
                port = candidate

    # On Windows the executable is npm.cmd; shutil.which handles the
    # shim resolution. Fall back to a bare 'npm' so the error message
    # at spawn time is informative ("npm not found") rather than a
    # generic FileNotFoundError.
    npm_path = shutil.which("npm.cmd") or shutil.which("npm") or "npm"
    # Used to spawn VJ-9000's own local vite CLI directly (see
    # _vite_spawn_cmd) instead of through the npm dev/preview scripts.
    node_path = shutil.which("node") or "node"

    dev_mode = os.getenv("theDAW_VJ_DEV") == "1"

    return VJConfig(
        project_path=project_path,
        port=port,
        npm_path=npm_path,
        node_path=node_path,
        dev_mode=dev_mode,
    )


# The URL subpath the backend serves the production VJ build under. The VJ
# build is compiled with vite `base: '/vj-app/'` so its assets resolve here.
STATIC_MOUNT_PATH = "/vj-app"


def _dist_candidates() -> list[Path]:
    """Search order for a servable VJ production build (``dist/``). Ordered
    from most explicit to least: an env override, the resolved project's own
    build, then release-bundle locations relative to the app. Every entry is
    derived from config/this file's location — nothing machine-specific."""
    cands: list[Path] = []
    d = os.getenv("theDAW_VJ_DIST")
    if d:
        cands.append(Path(d).expanduser().resolve())
    cands.append(resolve_config().project_path / "dist")  # dev checkout build
    cands.append(_REPO_ROOT / "vj-dist")  # dist-only release bundle
    cands.append(_REPO_ROOT / "vj" / "dist")  # full checkout bundle
    # Where `npm run fetch:vj` stages the build during dev — so testing the
    # static path locally needs no env var, just that one command.
    cands.append(_REPO_ROOT / "electron-ui" / "resources" / "vj-dist")
    return cands


def resolve_dist_dir() -> Optional[Path]:
    """First candidate that holds a real build (``index.html`` present), or
    None when nothing is servable yet."""
    for c in _dist_candidates():
        if (c / "index.html").is_file():
            return c
    return None


def is_static_mode() -> bool:
    """True when the backend should SERVE a static VJ build rather than spawn
    a Node dev/preview server. This is the default whenever a build is
    resolvable; ``theDAW_VJ_DEV=1`` forces the Node dev-server path instead."""
    if os.getenv("theDAW_VJ_DEV") == "1":
        return False
    return resolve_dist_dir() is not None


# Set True by server.py once the /vj-app route is registered, which it always
# is. The route resolves the build per request (server._serve_static_build), so
# a dist that appears mid-session — Pinokio's Update npm-installs the VJ
# checkout while theDAW is running — serves immediately instead of 404ing until
# the next backend restart.
STATIC_MOUNTED = False


def static_mount_active() -> bool:
    """True when a request to /vj-app would actually serve a build: the route
    is registered AND a dist is resolvable right now."""
    return STATIC_MOUNTED and resolve_dist_dir() is not None


def ensure_static_dist() -> Path:
    """Return the servable ``dist/`` dir for the static mount. When the
    resolved project is a full source checkout with npm available, refresh a
    stale/missing build first so dev checkouts stay current; a dist-only
    release bundle (no source, no npm) is served as-is. Raises RuntimeError
    naming the env overrides when nothing can be served."""
    cfg = resolve_config()
    proj = cfg.project_path
    has_source = (proj / "package.json").is_file()
    has_npm = bool(shutil.which("npm") or shutil.which("npm.cmd"))
    if has_source and has_npm:
        try:
            _ensure_build(cfg)  # no-op unless dist is missing or stale
        except RuntimeError as e:
            log.warning("vj.sidecar: static rebuild failed, using existing dist: %s", e)
    dist = resolve_dist_dir()
    if dist is None:
        raise RuntimeError(
            "VJ build not found. Point theDAW_VJ_PROJECT at a VJ checkout "
            "(it builds automatically when npm is present) or theDAW_VJ_DIST "
            "at a prebuilt dist/ folder."
        )
    return dist


def _newest_source_mtime(root: Path) -> float:
    newest = 0.0
    for name in _SOURCE_FILES:
        f = root / name
        if f.is_file():
            newest = max(newest, f.stat().st_mtime)
    for name in _SOURCE_DIRS:
        d = root / name
        if d.is_dir():
            for p in walk_files(d):
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
            env=child_env(),
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


def _vite_bin_js(project_path: Path) -> Path:
    """Path to VJ-9000's own local vite CLI entrypoint
    (``node_modules/vite/bin/vite.js``), spawned directly via ``node``
    instead of through the ``dev``/``preview`` npm scripts.

    Why: VJ-9000's ``package.json`` ``dev`` script is
    ``vite --port=3000 --host=0.0.0.0`` -- port 3000 is banned on this
    machine. The previous revision of this module appended its own
    ``--port <port>`` after that (``npm run dev -- --port <port>``),
    which happens to work ONLY because vite 6.4.2's bundled CLI arg
    parser keeps every repeated flag as an array (``mri2``'s ``toVal`` in
    ``node_modules/vite/dist/node/cli.js``: ``out[key] = old == null ? nxt
    : (Array.isArray(old) ? old.concat(nxt) : [old, nxt]);``) and each
    command's action then calls
    ``filterDuplicateOptions(options)``, which does
    ``options[key] = value[value.length - 1]`` -- i.e. the LAST ``--port``
    wins, confirmed by reading that exact vendored file. But VJ-9000's
    ``package.json`` pins vite with a caret range (``^6.2.3``, both in
    ``dependencies`` and ``devDependencies``), not an exact version, so a
    future ``npm install`` in that checkout could resolve a different
    minor/patch whose CLI dedup behavior isn't guaranteed to match. Rather
    than depend on that holding forever, we bypass the npm script and the
    ambiguity entirely: spawn vite directly with a single, unambiguous
    ``--port`` flag (see ``_vite_spawn_cmd``)."""
    return project_path / "node_modules" / "vite" / "bin" / "vite.js"


def _vite_spawn_cmd(cfg: VJConfig, *, preview: bool) -> list[str]:
    """Build the argv to spawn VJ-9000's own vite CLI directly (``node`` +
    ``_vite_bin_js``), with exactly one ``--port`` flag -- see
    ``_vite_bin_js``'s docstring for why this replaced
    ``npm run dev|preview -- --port ...``.

    Host binding matches what each mode already used before this change:
    dev mode carried ``--host=0.0.0.0`` inside VJ-9000's own ``dev`` npm
    script (now bypassed, so it's passed explicitly here); preview mode
    already passed a bare ``--host`` (binds all interfaces) directly.

    Dev mode now also gets ``--strictPort`` (preview already had it). This
    is an intentional behavior change from VJ-9000's own ``dev`` script,
    which had no ``--strictPort`` and would let vite silently slide to the
    next free port on a collision: this module's own port-collision
    handling (``_adopt_if_confirmed`` / ``_await_ready``'s identity check)
    depends on the child actually binding the port we resolved and told it
    to use, not some other port vite picked on its own, so a busy port
    must hard-fail here rather than silently move -- resolve_config()'s
    validation is also what keeps that resolved port off 3000 and out of
    the SA3 frontend's range in the first place."""
    vite_js = _vite_bin_js(cfg.project_path)
    cmd = [cfg.node_path, str(vite_js)]
    if preview:
        cmd += ["preview", "--port", str(cfg.port), "--strictPort", "--host"]
    else:
        cmd += ["--port", str(cfg.port), "--strictPort", "--host", "0.0.0.0"]
    return cmd


def _port_is_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True if something is already listening on ``host:port`` — used
    both for readiness polls and for detecting an existing VJ instance
    we shouldn't double-spawn."""
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


# Non-HTTP-protocol failures a loopback probe in this module can hit: refused
# / reset / timed-out connections (OSError, which urllib.error.URLError also
# subclasses), a malformed HTTP response from a non-HTTP listener such as an
# SSH banner (http.client.HTTPException, e.g. BadStatusLine -- NOT an
# OSError subclass, so it must be listed explicitly), and a malformed header
# value the stdlib client can't parse (ValueError).
_PROBE_ERRORS = (OSError, urllib.error.URLError, http.client.HTTPException, ValueError)

_EXR_ACCEPT_HEADER = {"Accept": "application/octet-stream"}


def _non_html_200(response: object) -> bool:
    """True for a 200 response whose Content-Type does not start with
    ``text/html``. Vite's dev-server SPA fallback (``htmlFallbackMiddleware``)
    answers ANY missing path with 200 ``text/html`` (the real index page)
    when no/loose Accept header is present, and some non-Vite SPA static
    servers do the same unconditionally regardless of Accept -- so a bare
    200 status is not sufficient proof this is the real asset (T30
    re-audit, proven against a real Vite 6.4.2 template server)."""
    if getattr(response, "status", None) != 200:
        return False
    content_type = response.headers.get("Content-Type", "")
    return not content_type.lower().startswith("text/html")


def _exr_marker_present(opener: urllib.request.OpenerDirector, port: int) -> bool:
    """True when ``GET /piz_compressed.exr`` answers a non-html 200. That
    asset lives at ``VJ-9000/public/piz_compressed.exr`` and Vite serves
    everything under ``public/`` at the site root in both dev and preview
    modes, so it is reachable at this exact path either way (verified
    directly against the real VJ-9000 checkout's ``public/``, ``index.html``,
    and ``vite.config.ts``).

    Sends ``Accept: application/octet-stream`` on both the HEAD and the
    GET-fallback request, and treats any ``text/html`` response as a miss
    regardless of status (see ``_non_html_200``) -- neither on its own is
    enough to rule out a SPA fallback that ignores Accept.

    Tries HEAD first, reading only the status/headers, never the body.
    Falls back to GET (again reading only the status/headers before closing
    the connection without consuming the body) ONLY when HEAD raises
    ``HTTPError`` 405 or 501 (method not supported) -- never for a genuine
    404 (the asset really isn't there) or a timeout (the listener is hung);
    retrying either of those on GET would either mask a real miss or double
    the time a hung/unrelated listener can stall this probe for.

    A real VJ-9000 instance -- ``vite`` dev server or ``vite preview`` --
    answers HEAD on a static asset with a normal 200 (Node's static-file
    serving path handles HEAD natively; verified against
    ``node_modules/vite/dist/node/chunks/dep-*.js``), so this fallback
    exists purely for defense against a DIFFERENT, non-Vite static server
    that might legitimately reject HEAD -- not because real VJ-9000 ever
    needs it.
    """
    url = f"http://127.0.0.1:{port}/piz_compressed.exr"
    try:
        req = urllib.request.Request(url, method="HEAD", headers=_EXR_ACCEPT_HEADER)
        with opener.open(req, timeout=1.0) as response:
            return _non_html_200(response)
    except urllib.error.HTTPError as e:
        if e.code not in (405, 501):
            return False
    except _PROBE_ERRORS:
        return False
    try:
        req = urllib.request.Request(url, headers=_EXR_ACCEPT_HEADER)
        with opener.open(req, timeout=1.0) as response:
            return _non_html_200(response)
    except _PROBE_ERRORS:
        return False


def _is_vj_server(port: int) -> bool:
    """Identity check: does whatever is listening on ``port`` answer as OUR
    VJ-9000 sidecar (dev or preview Vite server), not some other process that
    happened to grab the port first (same INT-001 shape as
    ``lyria/sidecar.py``'s ``_is_lyria_server``, which this is modeled on)?

    VJ-9000 has no backend API route of its own -- it's a pure static SPA
    (see the module docstring), so there's no JSON endpoint to probe the way
    foundry/sidecar.py and lyria/sidecar.py do. Two markers are required:

      * ``GET /piz_compressed.exr`` -> a non-html 200 (see
        ``_exr_marker_present``). This asset is VJ-9000-specific.
      * ``GET /`` HTML carries an asset/script reference naming this
        checkout specifically -- ``/src/main.tsx`` for a plain ``vite``
        dev server (unbundled source, served at ``/``), or
        ``/vj-app/assets/`` when the served ``dist/`` was produced by
        ``vite build`` (VJ-9000/vite.config.ts sets ``base: '/vj-app/'``
        for every ``vite build`` -- not a special "theDAW build" case --
        which gets baked into the built HTML/JS at build time). ``vite
        preview`` itself always serves at root ``/`` -- it resolves its
        own config with ``command: 'serve'``, not ``'build'`` (see
        ``preview()`` in ``node_modules/vite/dist/node/chunks/dep-*.js``),
        so its own ``base`` is ``/`` -- but it serves that already-built
        HTML byte-for-byte, so the ``/vj-app/assets/`` marker still shows
        up in its response body even though preview's own routing base is
        ``/``, not ``/vj-app/``.

    The earlier revision of this check also required
    ``<title>My Google AI Studio App</title>``. That title is the stock
    AI Studio scaffold template shared by other local AI-Studio-generated
    projects, and it is the field most likely to be renamed by a user, so
    it has been dropped as a weak/unreliable marker in favor of the exr
    asset, which is VJ-9000-specific.

    Uses a ``ProxyHandler({})`` opener rather than plain ``urlopen`` --
    which honours ``HTTP_PROXY``/``NO_PROXY`` from the environment by
    default -- for every loopback probe in this file, so a system/corporate
    proxy can never sit between theDAW and its own loopback sidecar (same
    rule as ``lyria/sidecar.py``'s ``_is_lyria_server``).

    Every probe in this function and in ``_exr_marker_present`` catches
    ``_PROBE_ERRORS`` (which includes ``http.client.HTTPException``), so a
    non-HTTP listener on the port (e.g. an SSH banner) makes this return
    False instead of raising -- same class of bug the Lyria audit found.
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if not _exr_marker_present(opener, port):
        return False
    try:
        with opener.open(f"http://127.0.0.1:{port}/", timeout=1.0) as response:
            body = response.read(4096)
    except _PROBE_ERRORS:
        return False
    return b"/src/main.tsx" in body or b"/vj-app/assets/" in body


def _adopt_if_confirmed(cfg: VJConfig, url: str) -> Optional[str]:
    """None if the port is free; ``url`` if a confirmed VJ-9000 instance is
    already listening there (our child, or one the user launched manually);
    raises if the port is held by something else (INT-001 shape: a bare TCP
    connect is not enough to adopt a listener as "our sidecar")."""
    if not _port_is_listening(cfg.port):
        return None
    if _is_vj_server(cfg.port):
        return url
    raise RuntimeError(
        f"Port {cfg.port} is already in use by another process that did not "
        "answer as the VJ sidecar. Set theDAW_VJ_PORT to a free port, or "
        "stop the process using it, then retry."
    )


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

    # Static mode: a bundled/resolvable build is served by the backend itself.
    # No Node process, no port, no npm — the only failure is "no build found".
    if is_static_mode():
        dist = resolve_dist_dir()
        issues: list[str] = []
        if dist is None:
            issues.append("no VJ build found — set theDAW_VJ_DIST or theDAW_VJ_PROJECT")
        return {
            "project_path": str(pkg),
            "dist_path": str(dist) if dist else None,
            "mode": "static",
            # In static mode "served" replaces the port-listening check.
            "listening": dist is not None,
            "process_alive": False,
            "url": f"{STATIC_MOUNT_PATH}/",
            "mobile_url": None,
            "lan_ip": detect_lan_ip(),
            "issues": issues,
        }

    pkg_json = pkg / "package.json"
    issues = []
    if not pkg.is_dir():
        issues.append(f"project path does not exist: {pkg}")
    elif not pkg_json.is_file():
        issues.append(f"no package.json at {pkg_json}")
    if not (shutil.which("npm") or shutil.which("npm.cmd")):
        issues.append("npm not found on PATH — install Node.js first")
    if not (shutil.which("node") or shutil.which("node.exe")):
        # node is what actually gets spawned now (see _vite_spawn_cmd) --
        # npm alone isn't sufficient to run the sidecar.
        issues.append("node not found on PATH — install Node.js first")
    # A TCP listener on the port isn't enough -- confirm it actually answers
    # as our VJ sidecar before reporting "listening" (INT-001 shape). A
    # listener that fails the identity check is a port collision, not us.
    port_open = _port_is_listening(cfg.port)
    listening = port_open and _is_vj_server(cfg.port)
    # Read the module-global _proc exactly once (unlocked -- probe() is a
    # read-only diagnostic and doesn't take _state_lock) and reuse that
    # single snapshot everywhere below; reading `_proc.poll()` a second
    # time later in this function could observe a different process state
    # (ensure_running()/stop() could run concurrently) and make one
    # response contradict itself (e.g. "starting" issue text alongside
    # process_alive=False).
    own_child_alive = _proc is not None and _proc.poll() is None
    if port_open and not listening and not own_child_alive:
        # Only a foreign listener is a collision worth flagging. When our
        # own child is alive but hasn't answered the identity check yet
        # (still starting up), that's not "in use by another process" --
        # it's ours, just not ready.
        issues.append(
            f"Port {cfg.port} is already in use by another process that is "
            "not the VJ sidecar. Set theDAW_VJ_PORT to a free port, or stop "
            "the process using it."
        )
    elif own_child_alive and not listening:
        issues.append("VJ sidecar is starting — not answering yet.")
    return {
        "project_path": str(pkg),
        "port": cfg.port,
        # HMR dev server (theDAW_VJ_DEV=1). Reached only when no static build
        # is resolvable, so this is the developer/live-edit path.
        "mode": "dev",
        "build_stale": _build_is_stale(pkg) if pkg.is_dir() else None,
        "listening": listening,
        "process_alive": own_child_alive,
        "url": _resolved_url or f"http://localhost:{cfg.port}",
        # LAN-reachable URL for phones/tablets (None if offline). The
        # Vite server is bound to 0.0.0.0 with allowedHosts disabled so
        # this address isn't rejected when a mobile device connects.
        "mobile_url": mobile_url_for(cfg.port),
        "lan_ip": detect_lan_ip(),
        "issues": issues,
    }


def ensure_running(*, wait_for_ready: bool = True) -> str:
    """Spawn the VJ Vite server (preview by default, dev with
    theDAW_VJ_DEV=1) if it isn't already, and return the URL it serves
    on. Safe to call repeatedly — no-ops if the port is already
    listening AND confirmed to be our sidecar (INT-001 shape), even if
    some other process started it."""
    global _proc, _resolved_url
    with _state_lock:
        cfg = resolve_config()
        url = f"http://localhost:{cfg.port}"

        if _proc is not None and _proc.poll() is None:
            # We already have a live child. Whatever is (or isn't yet)
            # listening on the port right now is OURS -- either that child
            # still starting up (not yet answering identity checks) or
            # already confirmed and ready. Never call _adopt_if_confirmed
            # here: it would raise "already in use by another process"
            # about our own subprocess on a transient identity-check miss
            # during startup. _await_ready() below confirms identity once
            # it actually answers, or times out with its own diagnosis.
            pass
        else:
            # No live child of ours — a listener here, if any, is either an
            # existing confirmed VJ-9000 instance (adopt it) or something
            # else entirely; a bare TCP connect isn't proof it's actually
            # our VJ sidecar.
            adopted = _adopt_if_confirmed(cfg, url)
            if adopted is not None:
                _resolved_url = adopted
                return adopted

            # No live child — spawn one.
            if not cfg.project_path.is_dir():
                raise RuntimeError(
                    f"VJ project not found at {cfg.project_path}. Set "
                    "theDAW_VJ_PROJECT to override."
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
                rc = -1
                try:
                    # Output goes to the sidecar log file so install failures
                    # are diagnosable; the timeout stops a hung npm (network
                    # stall) from pinning the state lock forever.
                    with _sidecar_log_handle() as install_log:
                        rc = subprocess.call(
                            install_cmd,
                            cwd=str(cfg.project_path),
                            stdout=install_log,
                            stderr=subprocess.STDOUT,
                            shell=False,
                            timeout=NPM_INSTALL_TIMEOUT_SEC,
                            env=_npm_install_env(),
                        )
                except FileNotFoundError as e:
                    raise RuntimeError(
                        f"VJ sidecar: npm not found ({e}). Install Node.js."
                    ) from e
                except subprocess.TimeoutExpired as e:
                    raise RuntimeError(
                        f"npm install timed out after {int(NPM_INSTALL_TIMEOUT_SEC)}s "
                        f"in {cfg.project_path} — check the network, then retry."
                    ) from e
                if rc != 0:
                    raise RuntimeError(
                        f"npm install failed in {cfg.project_path} (rc={rc}). "
                        f"See {SIDECAR_LOG_PATH} for the full output, then retry."
                    )
                log.info("vj.sidecar: npm install complete")
            # Spawn VJ-9000's own vite CLI directly (node + vite.js) rather
            # than through the npm dev/preview scripts -- see
            # _vite_bin_js's docstring for why (VJ-9000's dev script
            # hardcodes the banned port 3000).
            vite_js = _vite_bin_js(cfg.project_path)
            if not vite_js.is_file():
                raise RuntimeError(
                    f"VJ sidecar: vite not found at {vite_js}. Run npm "
                    f"install in {cfg.project_path} first."
                )
            if cfg.dev_mode:
                cmd = _vite_spawn_cmd(cfg, preview=False)
            else:
                # Production serve: build once (when stale), then `vite
                # preview` over dist/ — same port contract and SPA
                # behavior as the dev server, none of its per-request
                # work. `--host` (bare) binds 0.0.0.0 so the LAN/mobile
                # URL keeps working; allowedHosts is inherited from the
                # project's server config.
                _ensure_build(cfg)
                cmd = _vite_spawn_cmd(cfg, preview=True)
            log.info(
                "vj.sidecar: spawning %s (cwd=%s)",
                " ".join(cmd),
                cfg.project_path,
            )
            try:
                # CREATE_NEW_PROCESS_GROUP keeps the spawn quiet inside the
                # SA3 backend console instead of popping a separate cmd
                # window. stdout/stderr go to the sidecar log file
                # (data/logs/vj-sidecar.log) so a server that dies before
                # ready leaves its actual error somewhere findable instead
                # of vanishing into DEVNULL.
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                with _sidecar_log_handle() as spawn_out:
                    _proc = subprocess.Popen(
                        cmd,
                        cwd=str(cfg.project_path),
                        stdout=spawn_out,
                        stderr=subprocess.STDOUT,
                        creationflags=creationflags,
                        shell=False,
                        env=child_env(),
                    )
            except FileNotFoundError as e:
                raise RuntimeError(
                    f"Failed to launch VJ sidecar: {e}. Is Node.js on PATH?"
                ) from e

        if not wait_for_ready:
            _resolved_url = url
            return url

        return _await_ready(cfg, url)


def _await_ready(cfg: VJConfig, url: str) -> str:
    """Poll until the port is listening and confirmed as VJ-9000, the
    spawned child exits, or the readiness deadline passes. Split out of
    ``ensure_running()`` so the two distinct timeout diagnoses can be told
    apart: the port never opened at all (npm-install/vite startup hang) vs.
    the port opened but never answered as VJ-9000 (some other process is
    serving that port) -- and so this loop can be exercised directly in
    tests without spawning a real npm/vite process."""
    global _resolved_url
    deadline = time.monotonic() + PORT_READY_TIMEOUT_SEC
    port_opened_unconfirmed = False
    while time.monotonic() < deadline:
        if not _port_is_listening(cfg.port):
            if _proc is not None and _proc.poll() is not None:
                raise RuntimeError(
                    "VJ sidecar exited before becoming ready (rc="
                    f"{_proc.returncode}). See {SIDECAR_LOG_PATH} for the "
                    "child's actual output."
                )
            time.sleep(PORT_POLL_INTERVAL_SEC)
            continue
        # Something is listening. Re-check the deadline immediately before
        # the expensive identity probe (_is_vj_server can issue up to two
        # HTTP requests with a 1.0s timeout each) so a hung/slow listener
        # discovered right as the deadline expires can't push this
        # function's caller (ensure_running, which calls this inside
        # `with _state_lock:`) further past PORT_READY_TIMEOUT_SEC than one
        # such probe already costs.
        if time.monotonic() >= deadline:
            port_opened_unconfirmed = True
            break
        if _is_vj_server(cfg.port):
            _resolved_url = url
            log.info("vj.sidecar: ready at %s", url)
            return url
        port_opened_unconfirmed = True
        if _proc is not None and _proc.poll() is not None:
            raise RuntimeError(
                "VJ sidecar exited before becoming ready (rc="
                f"{_proc.returncode}). See {SIDECAR_LOG_PATH} for the "
                "child's actual output."
            )
        time.sleep(PORT_POLL_INTERVAL_SEC)
    if port_opened_unconfirmed:
        raise RuntimeError(
            f"VJ sidecar opened port {cfg.port} but did not answer as "
            "VJ-9000 (missing the /piz_compressed.exr asset and/or the "
            "/src/main.tsx or /vj-app/assets/ marker in GET /) within "
            f"{int(PORT_READY_TIMEOUT_SEC)}s. The process listening on that "
            "port may be serving a different project."
        )
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
                # We spawn `node vite.js` directly now (no npm.cmd shim
                # layer), but vite itself can still spawn worker children
                # (e.g. esbuild, optimizeDeps workers) -- terminate() only
                # signals the node process we hold the handle to, not its
                # children, so kill the whole tree via taskkill /T.
                subprocess.call(
                    ["taskkill", "/PID", str(_proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=child_env(),
                )
                _proc.wait(timeout=5.0)
            else:
                _proc.terminate()
                _proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            _proc.kill()
            try:
                # Reap the killed child so it doesn't linger as a zombie
                # until interpreter shutdown (POSIX).
                _proc.wait(timeout=5.0)
            except (subprocess.TimeoutExpired, OSError):
                pass
        finally:
            _proc = None
            _resolved_url = None
        return True
