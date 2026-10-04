"""Spawn, track and reap live ``thedaw-vst-host`` processes.

A ``vst3`` chain entry did nothing during playback: plugins only applied on
freeze/render, through pedalboard. The live path gives every chain entry its
own native host process so the user's real plugin processes the live signal,
and the browser talks to that process **directly** over a loopback WebSocket.
This module is only the process manager — no audio passes through the backend.

The wire contract is ``docs/design/vst-live-protocol.md``; the two sections
this file implements are "Host command line" and "Backend API".

One process per chain entry
---------------------------
Crash isolation: a plugin that takes its process down takes only its own. The
manager keeps at most one *alive* session per ``chain_entry_id`` — creating a
session for an entry that already has a live one running the SAME plugin
returns the existing session, because the frontend rebuilds its whole effect
chain on every play/stop/seek and must not respawn a plugin each time. A
different ``plugin_path`` or ``plugin_name`` for that entry is a swap, not a
rebuild: the old host is shut down (its state discarded with its session
directory) and a new one takes the slot, so the plugin the user picked is the
one in the signal path.

Locking
-------
There is ONE manager lock, and it is held across the whole spawn critical
section: the cap check, the per-chain-entry idempotency check, the ``Popen``
and the wait for the host's ``listening`` line. Releasing it between the check
and the insert is exactly how you get two hosts for one chain entry (or
``max_sessions + 1`` of them): both callers pass the check, both spawn, and the
loser's process leaks untracked. A plugin swap holds it too, not only a fresh
spawn: stopping the superseded host and waiting for it to exit (bounded by
``shutdown_timeout``) happens under the same lock as the new host's spawn,
because the stop and the respawn are one operation — see ``create()``. The
``DELETE`` path is the one that does NOT do this: it pops the session under
the lock and waits on the process outside it, and the stdout pump threads
never take the lock at all (they own only their own session's log handle), so
a wedged host cannot deadlock the manager. The periodic reaper below takes the
lock on every tick too, but only to poll already-exited processes and prune
expired ones — it never waits on one.

Reaping
-------
A crashed session is only noticed, and a dead one only forgotten, when
something calls ``reap()`` — so a manager backing a quiet chain would sit on a
crashed host and an undeletable directory forever without a background sweep.
The sweep is a daemon ``threading.Timer`` that the first session to exist
starts lazily; it reschedules itself every ``reap_interval`` seconds for as
long as any session — alive, or dead within ``DEAD_SESSION_TTL`` — remains,
and stops itself once the manager is empty rather than ticking forever.
``kill_all`` also cancels it directly, so no timer outlives the sessions it
watches. A session directory ``shutil.rmtree`` could not fully clear (a file
still open on Windows, say) is retried on the next sweep instead of being
abandoned.

Pipes
-----
``stdout`` is a pipe that a per-session thread drains for the whole life of the
process, not just until the ``listening`` line: a host that keeps logging into
a pipe nobody reads blocks in ``write()`` once the OS buffer fills (~64 KiB),
which looks exactly like a hung plugin. Everything the pump reads is appended
to the session log. ``stderr`` is handed the log file directly.

Logs
----
Three writers into one file is a Windows hazard, so a session has two log
files, not one: the pump above and the redirected ``stderr`` both append to
``<session>/host.log``, while the host's OWN ``--log`` output — its native
diagnostics, not the wire protocol carried on stdout — goes to the separate
``<session>/host-native.log``. ``LiveSession.log_tail()`` reads both and
reports the native lines first.

Privacy
-------
``raw_state`` is the user's plugin state. It is written to the session's state
file, read back out of it, and never logged — not at any level. API errors name
the plugin's *file name* only, never the directory it came from.
"""

from __future__ import annotations

import base64
import binascii
import functools
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from backend.lib import paths
from backend.lib.launch_token import child_env
from backend.lib.procs import is_zombie
from backend.lib.stamps import IncreasingClock
from backend.modules.vst.path_policy import PluginPathError, check_plugin_path

log = logging.getLogger(__name__)

# A session's started_at, strictly increasing: list() orders sessions newest
# first by it, and two opened in one 15.6 ms tick of Windows' clock tied and
# listed oldest first (backend/lib/stamps.py).
_session_stamp = IncreasingClock()

__all__ = [
    "DEAD_SESSION_TTL",
    "DEFAULT_MAX_SESSIONS",
    "EXIT_CODE_MEANINGS",
    "HOST_ENV_VAR",
    "LOG_ARCHIVE_LIMIT",
    "MAX_SESSIONS_ENV_VAR",
    "HostLocator",
    "LiveHostError",
    "LiveSession",
    "LiveSessionManager",
    "default_host_path",
    "get_manager",
    "kill_all",
    "pid_alive",
]

#: Wire protocol version this backend speaks (see the design doc).
PROTOCOL = 1

#: Host binary lookup: this environment variable wins over the built path.
HOST_ENV_VAR = "THEDAW_VST_HOST"
#: Concurrent-session cap override. The settings store only accepts keys that
#: already exist in its schema (``backend/modules/settings/store.py``), which is
#: outside this ticket's write set, so the knob is the environment for now.
MAX_SESSIONS_ENV_VAR = "THEDAW_VST_LIVE_MAX_SESSIONS"

DEFAULT_MAX_SESSIONS = 24
DEFAULT_SPAWN_TIMEOUT = 30.0
DEFAULT_SHUTDOWN_TIMEOUT = 5.0
#: How often the background sweep calls ``reap()`` while any session exists.
DEFAULT_REAP_INTERVAL = 60.0
#: How long a dead session stays queryable so the frontend can pull its last
#: state and log tail back out and recover the sound.
DEAD_SESSION_TTL = 600.0
#: How many finished sessions' logs are kept under ``<root>/logs``.
LOG_ARCHIVE_LIMIT = 50
LOG_TAIL_LINES = 40
_LOG_TAIL_BYTES = 64 * 1024

VALID_BLOCK_SIZES = (128, 256, 512, 1024, 2048)
MIN_SAMPLE_RATE = 8000
MAX_SAMPLE_RATE = 384000
MIN_CHANNELS = 1
MAX_CHANNELS = 8

#: The host's documented exit codes, in words a user can act on.
EXIT_CODE_MEANINGS: dict[int, str] = {
    0: "the host exited cleanly before it was ready",
    2: "the host rejected its command line",
    3: "the plugin file was not found",
    4: "the plugin failed to load or initialize",
    5: "the plugin does not support the requested channel layout",
    6: "the host could not open its local socket",
}

_HOST_BINARY = "thedaw-vst-host.exe" if sys.platform == "win32" else "thedaw-vst-host"
_NO_WINDOW = (
    getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
)


def default_host_path() -> Path:
    """Where the build drops the host binary — the locator's last candidate.

    A function rather than a constant so it follows ``paths.PROJECT_ROOT``, and
    so a test that needs the "host is not built" behaviour can point it at an
    empty directory. On a developer machine the real binary IS present, and a
    test that only unset ``THEDAW_VST_HOST`` would silently find it and assert
    against the wrong branch.
    """
    return paths.PROJECT_ROOT / "native" / "vst-host" / "bin" / _HOST_BINARY


def _idle_timeout_sec() -> int:
    """Seconds a host may sit with no client before it exits (0 = never).

    ``THEDAW_VST_LIVE_IDLE_SEC`` overrides the default of two minutes; a value
    that does not parse, or is out of the host's accepted range, is ignored.
    """
    raw = os.environ.get("THEDAW_VST_LIVE_IDLE_SEC", "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = -1
        if 0 <= value <= 86400:
            return value
    return 120


#: What the host writes when no class in the plugin file has the requested name.
NO_CLASS_NAMED = "no plugin named '"


class LiveHostError(RuntimeError):
    """A failure with the HTTP status the route should answer with."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------------------
# Small process / file helpers
# ---------------------------------------------------------------------------


def pid_alive(pid: int) -> bool:
    """Whether a process id is still running, without signalling it.

    ``os.kill(pid, 0)`` is not a probe on Windows — CPython maps ``os.kill``
    onto ``TerminateProcess`` there — so the Win32 wait is used instead. Same
    approach as ``_pid_alive`` in this package's ``router.py``.
    """
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        synchronize = 0x00100000
        wait_timeout = 0x00000102
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A child that exited and was not reaped yet still answers signal 0 on
    # Linux and macOS; a zombie runs nothing, so it is gone.
    return not is_zombie(pid)


def _close_quietly(handle: Any) -> None:
    try:
        if handle is not None and not handle.closed:
            handle.close()
    except Exception:  # noqa: BLE001 — teardown must never raise
        pass


def _terminate(proc: subprocess.Popen, timeout: float) -> None:
    """terminate(), then kill() if it is still there. Never raises."""
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        log.warning("vst.live: host pid %s would not die", proc.pid)


def _write_atomically(path: Path, payload: bytes) -> None:
    """Temp + replace, so a half-written state file can never be read back."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, path)


def _tail_lines(path: Path, limit: int = LOG_TAIL_LINES) -> list[str]:
    """The last ``limit`` non-blank lines of a log, reading only its tail."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - _LOG_TAIL_BYTES))
            blob = handle.read()
    except OSError:
        return []
    lines = [
        line.rstrip("\r")
        for line in blob.decode("utf-8", errors="replace").splitlines()
        if line.strip()
    ]
    return lines[-limit:]


def _os_reason(exc: OSError) -> str:
    """An OS error without its filename.

    ``str(OSError)`` appends the path it failed on, and these paths are the
    user's data directory — the API answers with the reason, not the location.
    """
    return exc.strerror or type(exc).__name__


def _read_state_b64(path: Path) -> Optional[str]:
    """The state file as base64, or None when there is nothing to hand back.

    The bytes are the user's plugin state and are never logged.
    """
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# Host binary discovery
# ---------------------------------------------------------------------------


class HostLocator:
    """Finds the host binary and explains its absence.

    Lookup order is the contract's: ``THEDAW_VST_HOST`` first, then
    ``native/vst-host/bin/thedaw-vst-host``. The environment is read on every
    call so a test (or a user who just built the host) takes effect without a
    restart.
    """

    def __init__(
        self, env_var: str = HOST_ENV_VAR, default_path: Optional[Path] = None
    ) -> None:
        self.env_var = env_var
        #: The built-host candidate. ``None`` means "ask ``default_host_path()``
        #: on every call", which is what production wants — a host built while
        #: the backend runs is picked up without a restart.
        self.default_path = Path(default_path) if default_path is not None else None
        self._version_cache: dict[tuple[str, int, int], str] = {}

    def candidates(self) -> list[Path]:
        found: list[Path] = []
        configured = os.environ.get(self.env_var, "").strip()
        if configured:
            found.append(Path(configured).expanduser())
        found.append(
            self.default_path if self.default_path is not None else default_host_path()
        )
        return found

    def resolve(self) -> Optional[Path]:
        for candidate in self.candidates():
            if candidate.is_file():
                return candidate
        return None

    def available(self) -> bool:
        return self.resolve() is not None

    def launch_prefix(self, host: Path) -> list[str]:
        """The argv prefix that runs ``host``.

        A ``.py`` host runs under this interpreter. That is how the tests point
        at ``tests/fake_vst_host.py``, and it also lets a developer aim
        ``THEDAW_VST_HOST`` at a script while the native host is being built.
        """
        if host.suffix.lower() == ".py":
            return [sys.executable, str(host)]
        return [str(host)]

    def version(self, host: Optional[Path] = None) -> Optional[str]:
        """The host's own version string, or its build time as a fallback.

        ``--version`` is a cheap call (no plugin is instantiated, unlike
        ``--selftest``). A host that does not implement it exits non-zero and
        the file's mtime is reported instead, which still tells a user which
        build they are running. Cached per (path, mtime, size) so ``GET /host``
        does not spawn a process on every poll.
        """
        host = host or self.resolve()
        if host is None:
            return None
        try:
            stat = host.stat()
        except OSError:
            return None
        key = (str(host), int(stat.st_mtime), int(stat.st_size))
        cached = self._version_cache.get(key)
        if cached is not None:
            return cached
        version = self._probe_version(host) or _build_stamp(stat.st_mtime)
        self._version_cache[key] = version
        return version

    def _probe_version(self, host: Path) -> Optional[str]:
        try:
            done = subprocess.run(
                [*self.launch_prefix(host), "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                env=child_env(),
                creationflags=_NO_WINDOW,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if done.returncode != 0:
            return None
        for line in (done.stdout or "").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except ValueError:
                return line[:120]
            if isinstance(payload, dict) and payload.get("version"):
                return str(payload["version"])[:120]
            return line[:120]
        return None

    def describe(self) -> dict[str, Any]:
        """``GET /api/vst/live/host``: is live VST on, and if not, why not."""
        host = self.resolve()
        if host is None:
            return {
                "available": False,
                "path": None,
                "version": None,
                "reason": (
                    "The live VST host (thedaw-vst-host) is not built. Build it "
                    "from native/vst-host, or point THEDAW_VST_HOST at the "
                    "binary. Plugins still apply on freeze and export."
                ),
            }
        return {
            "available": True,
            "path": str(host),
            "version": self.version(host),
            "reason": None,
        }


def _build_stamp(mtime: float) -> str:
    return "built " + time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_plugin(plugin_path: Any) -> str:
    """The plugin argument, validated and resolved.

    ``plugin_path`` is browser-supplied, untrusted input, so it goes through
    ``path_policy.check_plugin_path`` first (R5-2): the raw text must name a
    ``.vst3`` file or bundle, must not be a network/device path (UNC paths
    included), and must sit inside one of the scanned VST3 roots — the
    same directories the scanner itself offers in the UI, a plugin linked
    into one of them included (``path_policy.is_allowed``). Only after that
    does existence get checked; ``check_plugin_path`` validates shape and
    containment and never asks whether the plugin itself exists.
    """
    raw = str(plugin_path or "").strip()
    if not raw:
        raise LiveHostError(400, "plugin_path is required")
    try:
        resolved = check_plugin_path(raw)
    except PluginPathError as e:
        raise LiveHostError(e.status, e.message) from e
    # A VST3 is a file on some platforms and a bundle directory on others;
    # both are valid, so existence is the only remaining question.
    if not resolved.exists():
        raise LiveHostError(400, f"Plugin not found: '{resolved.name}'")
    return str(resolved)


def _validate_audio(sample_rate: Any, block_size: Any, channels: Any) -> None:
    if not isinstance(sample_rate, int) or not (
        MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE
    ):
        raise LiveHostError(
            400,
            f"sample_rate must be an integer between {MIN_SAMPLE_RATE} and "
            f"{MAX_SAMPLE_RATE} Hz (got {sample_rate})",
        )
    if block_size not in VALID_BLOCK_SIZES:
        raise LiveHostError(
            400,
            f"block_size must be one of {list(VALID_BLOCK_SIZES)} (got {block_size})",
        )
    if not isinstance(channels, int) or not (MIN_CHANNELS <= channels <= MAX_CHANNELS):
        raise LiveHostError(
            400,
            f"channels must be between {MIN_CHANNELS} and {MAX_CHANNELS} "
            f"(got {channels})",
        )


def _decode_raw_state(raw_state: Any) -> Optional[bytes]:
    if raw_state is None:
        return None
    if not isinstance(raw_state, str):
        raise LiveHostError(400, "raw_state must be a base64 string")
    text = raw_state.strip()
    if not text:
        return None
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise LiveHostError(400, "raw_state is not valid base64") from exc


def _max_sessions_from_env() -> int:
    raw = os.environ.get(MAX_SESSIONS_ENV_VAR, "").strip()
    if not raw:
        return DEFAULT_MAX_SESSIONS
    try:
        value = int(raw)
    except ValueError:
        log.warning(
            "vst.live: %s=%r is not a number — using %d",
            MAX_SESSIONS_ENV_VAR,
            raw,
            DEFAULT_MAX_SESSIONS,
        )
        return DEFAULT_MAX_SESSIONS
    return max(1, value)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


@dataclass
class LiveSession:
    """One ``thedaw-vst-host`` process and the files that belong to it."""

    session_id: str
    chain_entry_id: str
    plugin_path: str
    plugin_name: Optional[str]
    sample_rate: int
    block_size: int
    channels: int
    dir: Path
    log_path: Path
    native_log_path: Path
    state_path: Path
    argv: list[str]
    proc: subprocess.Popen
    started_at: float
    port: Optional[int] = None
    protocol: int = PROTOCOL
    alive: bool = True
    exit_code: Optional[int] = None
    ended_at: Optional[float] = None
    # The user's plugin state, captured when the process ended. Never logged;
    # kept out of repr() so it cannot reach a log through an exception either.
    final_state_b64: Optional[str] = field(default=None, repr=False)

    @property
    def pid(self) -> int:
        return self.proc.pid

    @property
    def ws_url(self) -> Optional[str]:
        return f"ws://127.0.0.1:{self.port}" if self.port else None

    @property
    def plugin_file(self) -> str:
        """The plugin's file name — the only part of its path the API exposes."""
        return Path(self.plugin_path).name

    def log_tail(self, limit: int = LOG_TAIL_LINES) -> list[str]:
        """The tail of both this session's log files, the host's own first.

        The host's ``--log`` output (its native diagnostics) and this
        backend's capture of its stdout/stderr are two separate files — see
        the module docstring's "Logs" section — so this reads both, each
        independently capped at ``limit`` so a chatty pump can never crowd
        the host's own diagnostics out entirely.
        """
        return _tail_lines(self.native_log_path, limit) + _tail_lines(
            self.log_path, limit
        )

    def to_dict(self, log_tail_lines: int = LOG_TAIL_LINES) -> dict[str, Any]:
        """The session as the API reports it. Never carries ``raw_state``."""
        return {
            "session_id": self.session_id,
            "chain_entry_id": self.chain_entry_id,
            "plugin_file": self.plugin_file,
            "plugin_name": self.plugin_name,
            "sample_rate": self.sample_rate,
            "block_size": self.block_size,
            "channels": self.channels,
            "alive": self.alive,
            "pid": self.pid,
            "port": self.port,
            "ws_url": self.ws_url,
            "protocol": self.protocol,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "exit_code": self.exit_code,
            # Whether DELETE would return something, without shipping the bytes.
            "has_state": bool(self.final_state_b64) or self.state_path.is_file(),
            "log_tail": self.log_tail(log_tail_lines),
        }


def _pump_stdout(
    stream: Any, log_path: Path, ready: threading.Event, box: dict[str, int]
) -> None:
    """Drain the host's stdout for the whole life of the process.

    This must not stop at the ``listening`` line: a host that keeps writing
    into a pipe nobody reads blocks in ``write()`` once the OS buffer fills,
    and from outside that is indistinguishable from a hung plugin. Every line
    is appended to the session log first and only then examined, so a caller
    woken by ``ready`` always finds the line already on disk.
    """
    try:
        with open(log_path, "a", encoding="utf-8", errors="replace") as sink:
            for raw in stream:
                line = raw.rstrip("\r\n")
                if not line:
                    continue
                try:
                    sink.write(line + "\n")
                    sink.flush()
                except OSError:
                    pass
                if ready.is_set() or '"listening"' not in line:
                    continue
                try:
                    payload = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(payload, dict) or payload.get("ev") != "listening":
                    continue
                try:
                    box["port"] = int(payload.get("port") or 0)
                    box["protocol"] = int(payload.get("protocol") or PROTOCOL)
                except (TypeError, ValueError):
                    box["port"] = 0
                ready.set()
    except Exception:  # noqa: BLE001 — a reader thread must never escape
        log.debug("vst.live: stdout pump ended abnormally", exc_info=True)
    finally:
        _close_quietly(stream)


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class LiveSessionManager:
    """Owns every live host process this backend started."""

    def __init__(
        self,
        locator: Optional[HostLocator] = None,
        root: Optional[Path] = None,
        max_sessions: Optional[int] = None,
        spawn_timeout: float = DEFAULT_SPAWN_TIMEOUT,
        shutdown_timeout: float = DEFAULT_SHUTDOWN_TIMEOUT,
        reap_interval: float = DEFAULT_REAP_INTERVAL,
    ) -> None:
        self.locator = locator or HostLocator()
        # Sibling of the editor path's data_path("vst_presets").
        self.root = Path(root) if root is not None else paths.data_path("vst_live")
        self.archive_dir = self.root / "logs"
        self.max_sessions = (
            _max_sessions_from_env()
            if max_sessions is None
            else max(1, int(max_sessions))
        )
        self.spawn_timeout = float(spawn_timeout)
        self.shutdown_timeout = float(shutdown_timeout)
        self.reap_interval = float(reap_interval)
        # THE manager lock. See the module docstring for why it spans the spawn.
        self._lock = threading.RLock()
        self._sessions: dict[str, LiveSession] = {}
        # Directories a sweep's ``shutil.rmtree`` could not fully clear, so the
        # next sweep retries them instead of leaving them behind forever.
        self._pending_removal: set[Path] = set()
        # The lazily started periodic sweep — see the module docstring's
        # "Reaping" section.
        self._reap_timer: Optional[threading.Timer] = None

    # -- queries ---------------------------------------------------------

    def get(self, session_id: str) -> LiveSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise LiveHostError(404, f"No live VST session '{session_id}'")
        return session

    def list(self) -> list[LiveSession]:
        """Every tracked session, alive first, newest first within each group."""
        with self._lock:
            sessions = list(self._sessions.values())
        return sorted(sessions, key=lambda s: (not s.alive, -s.started_at))

    def host_info(self) -> dict[str, Any]:
        return self.locator.describe()

    # -- creation --------------------------------------------------------

    def create(
        self,
        *,
        chain_entry_id: str,
        plugin_path: str,
        sample_rate: int,
        plugin_name: Optional[str] = None,
        block_size: int = 512,
        channels: int = 2,
        raw_state: Optional[str] = None,
    ) -> LiveSession:
        """Start a host for ``chain_entry_id``, or return its running one.

        Validation, base64 decoding and host lookup all happen BEFORE the lock
        is taken: none of them need it, and a rejected request must not stall a
        spawn that is already in flight.
        """
        entry_id = str(chain_entry_id or "").strip()
        if not entry_id:
            raise LiveHostError(400, "chain_entry_id is required")
        plugin = _validate_plugin(plugin_path)
        _validate_audio(sample_rate, block_size, channels)
        # "" and omitted both mean "no name" — normalised once, here, so the
        # swap comparison below and the spawn argv both see the same value.
        plugin_name = (plugin_name or "").strip() or None
        state_bytes = _decode_raw_state(raw_state)

        host = self.locator.resolve()
        if host is None:
            raise LiveHostError(503, self.locator.describe()["reason"])

        with self._lock:
            self._reap_locked()
            superseded: Optional[LiveSession] = None
            for session in self._sessions.values():
                if not (session.alive and session.chain_entry_id == entry_id):
                    continue
                if session.plugin_path == plugin and session.plugin_name == plugin_name:
                    # Idempotent per chain entry while the process is alive AND
                    # still running the same plugin: the frontend rebuilds its
                    # whole effect chain on every play/stop/seek.
                    return session
                # Same slot, different plugin: the user swapped it. Returning
                # the running session would leave the OLD plugin in the signal
                # path, because the frontend has no reason to DELETE a session
                # it just asked for.
                superseded = session
                break
            if superseded is not None:
                self._sessions.pop(superseded.session_id, None)
                # Under the lock on purpose. This waits on a process (bounded
                # by shutdown_timeout), which the DELETE path deliberately does
                # outside the lock — but here the stop and the respawn are ONE
                # operation: dropping the lock between them is how a concurrent
                # create for this same chain entry ends up with two hosts. The
                # old plugin's state goes with its session directory; the new
                # plugin must not inherit it.
                self._stop(superseded)
                log.info(
                    "vst.live: chain entry %s swapped plugin — session %s replaced",
                    entry_id,
                    superseded.session_id,
                )
            alive = sum(1 for s in self._sessions.values() if s.alive)
            if alive >= self.max_sessions:
                raise LiveHostError(
                    429,
                    f"Too many live VST plugins: {alive} of {self.max_sessions} "
                    f"allowed. Close one, or raise {MAX_SESSIONS_ENV_VAR}.",
                )
            spawn = functools.partial(
                self._spawn_locked,
                host=host,
                chain_entry_id=entry_id,
                plugin=plugin,
                sample_rate=sample_rate,
                block_size=block_size,
                channels=channels,
                state_bytes=state_bytes,
            )
            try:
                return spawn(plugin_name=plugin_name)
            except LiveHostError as exc:
                # A chain names its plugin after the file it came from
                # ("FreeGain"), which need not be the name the plugin gives
                # itself ("Free Gain"). When the file holds no class by that
                # name, the file's own effect is the one that was picked.
                if not plugin_name or NO_CLASS_NAMED not in exc.detail:
                    raise
                log.info(
                    "vst.live: %s has no class named %r; starting its own effect",
                    Path(plugin).name,
                    plugin_name,
                )
                session = spawn(plugin_name=None)
            # Asked for under that name: the next create for this entry with
            # the same name is the same plugin, not a swap.
            session.plugin_name = plugin_name
            return session

    def _spawn_locked(
        self,
        *,
        host: Path,
        chain_entry_id: str,
        plugin: str,
        plugin_name: Optional[str],
        sample_rate: int,
        block_size: int,
        channels: int,
        state_bytes: Optional[bytes],
    ) -> LiveSession:
        session_id = uuid.uuid4().hex[:16]
        session_dir = self.root / session_id
        log_path = session_dir / "host.log"
        native_log_path = session_dir / "host-native.log"
        state_path = session_dir / "state.bin"
        try:
            session_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise LiveHostError(
                500,
                f"Could not create the live VST session directory: {_os_reason(exc)}",
            ) from exc

        # BEFORE the spawn: the host reads --state-file at startup, so the
        # plugin comes up already dialled in rather than at its defaults.
        if state_bytes is not None:
            try:
                _write_atomically(state_path, state_bytes)
            except OSError as exc:
                raise LiveHostError(
                    500,
                    f"Could not write the live VST session state: {_os_reason(exc)}",
                ) from exc

        argv = [*self.locator.launch_prefix(host), "--plugin", plugin]
        if plugin_name:
            argv += ["--plugin-name", plugin_name]
        argv += [
            "--sample-rate",
            str(sample_rate),
            "--block-size",
            str(block_size),
            "--channels",
            str(channels),
            "--state-file",
            str(state_path),
            "--port",
            "0",
            # The host exits if this backend disappears, which covers a crash
            # that never reaches the lifespan shutdown hook.
            "--parent-pid",
            str(os.getpid()),
            # A host nobody is connected to exits by itself: a browser tab that crashed or was
            # killed never sends the DELETE its unload handler would have, and without this the
            # plugin process lived until the backend stopped. The host keeps running while a
            # client is connected or its editor window is open, however long that is, and it
            # writes its state file on the way out, so a later reconnect restores the settings.
            "--idle-timeout",
            str(_idle_timeout_sec()),
            # The host's OWN log, not the wire protocol on stdout: a separate
            # file from host.log (stdout pump + stderr) so the two never share
            # one file — see the module docstring's "Logs" section.
            "--log",
            str(native_log_path),
        ]

        started_at = _session_stamp()
        log_handle = None
        try:
            log_handle = open(log_path, "ab")
        except OSError:
            log_handle = None
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(paths.PROJECT_ROOT),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log_handle or subprocess.DEVNULL,
                env=child_env(),
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=_NO_WINDOW,
            )
        except OSError as exc:
            # Close before the cleanup below: Windows will not remove a
            # directory that still holds an open file.
            _close_quietly(log_handle)
            self._archive_log(session_id, log_path)
            self._archive_log(session_id, native_log_path, suffix="-native")
            if not _remove_tree(session_dir):
                self._note_removal_failure(session_dir)
            raise LiveHostError(
                503, f"Could not start the live VST host: {_os_reason(exc)}"
            ) from exc
        finally:
            # Popen duplicated the handle; ours must go or the log stays open
            # for as long as this process lives. Idempotent with the close above.
            _close_quietly(log_handle)

        ready = threading.Event()
        box: dict[str, int] = {}
        pump = threading.Thread(
            target=_pump_stdout,
            args=(proc.stdout, log_path, ready, box),
            name=f"vst-live-{session_id}",
            daemon=True,
        )
        pump.start()

        failure = self._await_listening(
            proc, pump, ready, box, log_path, native_log_path
        )
        if failure is not None:
            _close_quietly(proc.stdin)
            self._archive_log(session_id, log_path)
            self._archive_log(session_id, native_log_path, suffix="-native")
            if not _remove_tree(session_dir):
                self._note_removal_failure(session_dir)
            raise failure

        session = LiveSession(
            session_id=session_id,
            chain_entry_id=chain_entry_id,
            plugin_path=plugin,
            plugin_name=plugin_name,
            sample_rate=sample_rate,
            block_size=block_size,
            channels=channels,
            dir=session_dir,
            log_path=log_path,
            native_log_path=native_log_path,
            state_path=state_path,
            argv=argv,
            proc=proc,
            started_at=started_at,
            port=box.get("port"),
            protocol=box.get("protocol", PROTOCOL),
        )
        self._sessions[session_id] = session
        self._ensure_reap_timer_locked()
        log.info(
            "vst.live: session %s up on port %s (pid %s) for chain entry %s",
            session_id,
            session.port,
            proc.pid,
            chain_entry_id,
        )
        return session

    def _await_listening(
        self,
        proc: subprocess.Popen,
        pump: threading.Thread,
        ready: threading.Event,
        box: dict[str, int],
        log_path: Path,
        native_log_path: Path,
    ) -> Optional[LiveHostError]:
        """Wait for the host's ``listening`` line. Returns the error, if any.

        Returning rather than raising keeps the caller's cleanup (archive the
        log, drop the directory, close the pipes) in exactly one place. Both
        ``log_path`` (the pump/stderr capture) and ``native_log_path`` (the
        host's own ``--log`` output) are threaded through to every failure
        detail below, mirroring ``LiveSession.log_tail()``.
        """
        deadline = time.monotonic() + self.spawn_timeout
        while True:
            if ready.wait(0.05):
                break
            code = proc.poll()
            if code is not None:
                # It may have printed `listening` and died a moment later;
                # give the pump a beat to finish the pipe before deciding.
                pump.join(timeout=1.0)
                if ready.is_set():
                    break
                return LiveHostError(
                    502, _early_exit_detail(code, log_path, native_log_path)
                )
            if time.monotonic() >= deadline:
                _terminate(proc, 5.0)
                pump.join(timeout=1.0)
                return LiveHostError(
                    504,
                    _timeout_detail(self.spawn_timeout, log_path, native_log_path),
                )

        port = box.get("port") or 0
        if not 0 < port < 65536:
            _terminate(proc, 5.0)
            pump.join(timeout=1.0)
            return LiveHostError(
                502,
                "The live VST host announced an unusable port "
                f"({port}). " + _log_suffix(log_path, native_log_path),
            )
        return None

    # -- teardown --------------------------------------------------------

    def delete(self, session_id: str) -> dict[str, Any]:
        """Stop a session and hand back the state the host wrote on its way out."""
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            raise LiveHostError(404, f"No live VST session '{session_id}'")
        # Outside the lock on purpose: this waits on a process.
        return self._stop(session)

    def _stop(self, session: LiveSession) -> dict[str, Any]:
        proc = session.proc
        if proc.poll() is None:
            _request_shutdown(proc)
            try:
                proc.wait(timeout=self.shutdown_timeout)
            except subprocess.TimeoutExpired:
                # EOF on stdin is also "shutdown" per the contract; give that
                # a moment before resorting to signals.
                _close_quietly(proc.stdin)
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    log.warning(
                        "vst.live: session %s ignored shutdown — terminating",
                        session.session_id,
                    )
                    _terminate(proc, 3.0)
        return self._finalize(session)

    def _finalize(self, session: LiveSession) -> dict[str, Any]:
        _close_quietly(session.proc.stdin)
        session.alive = False
        session.exit_code = session.proc.poll()
        session.ended_at = session.ended_at or time.time()
        raw_state = _read_state_b64(session.state_path) or session.final_state_b64
        session.final_state_b64 = raw_state
        result = {
            "session_id": session.session_id,
            "chain_entry_id": session.chain_entry_id,
            "exit_code": session.exit_code,
            "raw_state": raw_state,
            "log_tail": session.log_tail(),
        }
        self._archive_log(session.session_id, session.log_path)
        self._archive_log(session.session_id, session.native_log_path, suffix="-native")
        if not _remove_tree(session.dir):
            self._note_removal_failure(session.dir)
        return result

    def kill_all(self) -> None:
        """Stop every session. Called from the backend's lifespan shutdown.

        Every host is asked to shut down first and the waits share ONE budget,
        so twenty-four sessions cost one ``shutdown_timeout``, not twenty-four
        of them — while still giving each plugin time to write its state.
        """
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            self._cancel_reap_timer_locked()
        if not sessions:
            return
        for session in sessions:
            if session.proc.poll() is None:
                _request_shutdown(session.proc)
        deadline = time.monotonic() + self.shutdown_timeout
        for session in sessions:
            try:
                session.proc.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        for session in sessions:
            try:
                if session.proc.poll() is None:
                    _close_quietly(session.proc.stdin)
                    _terminate(session.proc, 3.0)
                self._finalize(session)
            except Exception:  # noqa: BLE001 — teardown must never break exit
                log.debug(
                    "vst.live: could not finalize session %s",
                    session.session_id,
                    exc_info=True,
                )

    # -- reaping ---------------------------------------------------------

    def reap(self) -> None:
        """Notice hosts that died, and forget the ones dead long enough."""
        with self._lock:
            self._reap_locked()

    def _reap_locked(self) -> None:
        self._retry_pending_removals_locked()
        now = time.time()
        for session in list(self._sessions.values()):
            if session.alive:
                code = session.proc.poll()
                if code is None:
                    continue
                session.alive = False
                session.exit_code = code
                session.ended_at = now
                # Grab whatever state the host managed to write: the frontend
                # has DEAD_SESSION_TTL to pull it back and recover the sound.
                session.final_state_b64 = _read_state_b64(session.state_path)
                _close_quietly(session.proc.stdin)
                log.warning(
                    "vst.live: session %s (%s) exited on its own with code %s",
                    session.session_id,
                    session.plugin_file,
                    code,
                )
            elif (
                session.ended_at is not None
                and now - session.ended_at > DEAD_SESSION_TTL
            ):
                self._sessions.pop(session.session_id, None)
                self._archive_log(session.session_id, session.log_path)
                self._archive_log(
                    session.session_id, session.native_log_path, suffix="-native"
                )
                if not _remove_tree(session.dir):
                    self._note_removal_failure(session.dir)

    def _retry_pending_removals_locked(self) -> None:
        """Directories a previous sweep could not clear get another try here."""
        if not self._pending_removal:
            return
        for directory in list(self._pending_removal):
            if _remove_tree(directory):
                self._pending_removal.discard(directory)

    def _note_removal_failure(self, directory: Path) -> None:
        """Track a directory ``_remove_tree`` could not fully clear so the
        next sweep retries it instead of it being left behind forever.
        """
        with self._lock:
            self._pending_removal.add(directory)

    # -- periodic sweep ----------------------------------------------------

    def _ensure_reap_timer_locked(self) -> None:
        """Lazily start the sweep the first time a session exists."""
        if self._reap_timer is None:
            self._start_reap_timer_locked()

    def _start_reap_timer_locked(self) -> None:
        timer = threading.Timer(self.reap_interval, self._reap_tick)
        timer.daemon = True
        self._reap_timer = timer
        timer.start()

    def _cancel_reap_timer_locked(self) -> None:
        if self._reap_timer is not None:
            self._reap_timer.cancel()
            self._reap_timer = None

    def _reap_tick(self) -> None:
        """One sweep. Reschedules itself, or stops once nothing remains."""
        with self._lock:
            try:
                self._reap_locked()
            except Exception:  # noqa: BLE001 — a background sweep must never die
                log.debug("vst.live: periodic reap failed", exc_info=True)
            if self._sessions:
                self._start_reap_timer_locked()
            else:
                self._reap_timer = None

    # -- logs ------------------------------------------------------------

    def _archive_log(self, session_id: str, log_path: Path, suffix: str = "") -> None:
        """Keep a finished session's log after its directory goes away.

        ``suffix`` gives the host's native ``--log`` output (``"-native"``)
        its own archive name so it lands alongside, rather than colliding
        with, the pump/stderr capture (``suffix=""``) — see the module
        docstring's "Logs" section. Every call site archives both files.
        """
        if not log_path.is_file():
            return
        try:
            self.archive_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(log_path, self.archive_dir / f"{session_id}{suffix}.log")
        except OSError:
            log.debug("vst.live: could not archive %s", log_path, exc_info=True)
            return
        self.prune_archived_logs()

    def prune_archived_logs(self, limit: int = LOG_ARCHIVE_LIMIT) -> None:
        """Keep only the newest ``limit`` archived logs."""
        try:
            logs = sorted(
                self.archive_dir.glob("*.log"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return
        for stale in logs[limit:]:
            try:
                stale.unlink()
            except OSError:
                pass


def _request_shutdown(proc: subprocess.Popen) -> None:
    """``{"op":"shutdown"}`` on stdin: the host writes its state and exits 0."""
    try:
        if proc.stdin is not None and not proc.stdin.closed:
            proc.stdin.write(json.dumps({"op": "shutdown"}) + "\n")
            proc.stdin.flush()
    except (OSError, ValueError):
        # Already gone, or the pipe is closed: the caller escalates from here.
        pass


def _remove_tree(directory: Path) -> bool:
    """Best-effort removal. Returns whether ``directory`` is actually gone."""
    try:
        shutil.rmtree(directory, ignore_errors=True)
    except OSError:
        pass
    return not directory.exists()


def _log_suffix(log_path: Path, native_log_path: Path) -> str:
    """Both logs' tails, the host's own native diagnostics first.

    Mirrors ``LiveSession.log_tail()`` (see the module docstring's "Logs"
    section) so a spawn failure surfaces the host's own ``--log`` output too,
    not only the pump/stderr capture.
    """
    tail = _tail_lines(native_log_path) + _tail_lines(log_path)
    return ("Log tail: " + " | ".join(tail)) if tail else "The host logged nothing."


def _early_exit_detail(code: int, log_path: Path, native_log_path: Path) -> str:
    meaning = EXIT_CODE_MEANINGS.get(code, f"the host exited with code {code}")
    return (
        f"The live VST host stopped before it was ready (exit code {code}): "
        f"{meaning}. " + _log_suffix(log_path, native_log_path)
    )


def _timeout_detail(timeout: float, log_path: Path, native_log_path: Path) -> str:
    return (
        f"The live VST host did not report a port within {timeout:.0f}s and was "
        "stopped. " + _log_suffix(log_path, native_log_path)
    )


# ---------------------------------------------------------------------------
# Process-wide manager
# ---------------------------------------------------------------------------

_MANAGER: Optional[LiveSessionManager] = None
_MANAGER_LOCK = threading.Lock()


def get_manager() -> LiveSessionManager:
    """The manager this backend uses. Created on first use."""
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            _MANAGER = LiveSessionManager()
        return _MANAGER


def kill_all() -> None:
    """Stop every live host. Safe to call when nothing was ever started."""
    with _MANAGER_LOCK:
        manager = _MANAGER
    if manager is not None:
        manager.kill_all()
