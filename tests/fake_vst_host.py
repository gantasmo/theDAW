"""A stand-in for ``thedaw-vst-host`` that behaves like the real one.

``tests/test_vst_live_host.py`` drives the backend session manager
(``backend/modules/vst/live_host.py``) against THIS script instead of the
native binary, which is built separately (batch-11 T40) and is not on disk in
CI. Everything the manager cares about is process management, so the fake
reproduces exactly that surface of the contract in
``docs/design/vst-live-protocol.md``:

* the same argv (``--plugin``, ``--sample-rate``, ``--block-size``,
  ``--channels``, ``--state-file``, ``--port``, ``--parent-pid``, ``--log``,
  ``--plugin-name`` / ``--class-id``, ``--idle-timeout``, ``--null-plugin``,
  ``--list``, ``--selftest``, ``--version``), with argparse's exit code 2 for
  bad args;
* ``--log <path>`` is honoured: a short native-diagnostic line is written
  straight to that file, separately from the stderr the backend already
  redirects into the session's OWN log — this is what proves the two are
  different files;
* one structured stdout line when the socket is up —
  ``{"ev":"listening","port":N,"pid":P,"protocol":1}``;
* a real loopback WebSocket server on an OS-assigned port, so the ``ws_url``
  the backend hands the browser is actually connectable (it echoes text
  frames, which is all the manager's tests need);
* line-delimited JSON on stdin: ``{"op":"shutdown"}`` — and EOF — write the
  state file atomically (temp + ``os.replace``) and exit 0;
* the documented exit codes (2 bad args, 3 plugin missing, 4 load failed,
  5 bus layout, 6 socket error).

Behaviour the tests need to provoke is selected through environment variables
rather than extra flags, so the argv stays byte-for-byte what the real host
will receive:

``FAKE_VST_HOST_EXIT_CODE``      exit with this code before listening.
``FAKE_VST_HOST_EXIT_MESSAGE``   write this to stderr before that exit.
``FAKE_VST_HOST_LISTEN_DELAY``   seconds to sleep before the listening line.
``FAKE_VST_HOST_HANG``           never print listening; idle until killed.
``FAKE_VST_HOST_IGNORE_SHUTDOWN`` ignore stdin/EOF, forcing terminate/kill.
``FAKE_VST_HOST_CHATTER``        extra stdout lines after listening, so the
                                 manager's drain thread is exercised (an
                                 undrained pipe wedges the child at ~64 KiB).
``FAKE_VST_HOST_WATCH_PARENT``   enable the ``--parent-pid`` watcher (off by
                                 default so tests stay deterministic).
``FAKE_VST_HOST_RENDER_WARNINGS`` JSON array of warnings the ``--render``
                                 report carries, so the backend's
                                 ``X-Vst-Warnings`` plumbing is exercised.
``FAKE_VST_HOST_RENDER_ECHO``    add ``echo: …`` warnings naming the state
                                 size and the render flags the backend passed.

``--render`` (``tests/test_vst_render_host.py``) copies ``--in`` to ``--out``
and prints the real report's shape (``ok``/``mode``/``warnings``) on stdout;
``FAKE_VST_HOST_EXIT_CODE`` overrides its exit code too.

The state file it writes on shutdown is whatever it read at startup with
``b"|shutdown"`` appended, which lets a test prove the whole round trip:
backend writes ``raw_state`` before the spawn, the host sees it, the host
rewrites it on shutdown, the backend reads it back out of ``DELETE``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

PROTOCOL = 1
SHUTDOWN_SUFFIX = b"|shutdown"


def _log(message: str) -> None:
    """Diagnostics go to stderr, which the backend redirects into the log."""
    print(message, file=sys.stderr, flush=True)


def _emit(payload: dict) -> None:
    """One structured JSON line on stdout, exactly like the real host."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="thedaw-vst-host", add_help=True)
    parser.add_argument("--plugin")
    parser.add_argument("--plugin-name")
    parser.add_argument("--class-id")
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--block-size", type=int, default=512)
    parser.add_argument("--channels", type=int, default=2)
    parser.add_argument("--state-file")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--idle-timeout", type=int)
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--log")
    parser.add_argument("--null-plugin", action="store_true")
    # --render and its file arguments (the offline mode the backend's
    # /process-file route drives).
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--in", dest="in_path")
    parser.add_argument("--out", dest="out_path")
    parser.add_argument("--params-json")
    parser.add_argument("--midi-events")
    parser.add_argument("--automation-json")
    parser.add_argument("--tail-seconds")
    parser.add_argument("--host-name")
    parser.add_argument("--iid-log", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--version", action="store_true")
    # argparse exits 2 on unknown or malformed args, which is the contract's
    # "bad args" code, so no extra handling is needed here.
    return parser.parse_args(argv)


def _pid_alive(pid: int) -> bool:
    """Whether a process id is still running, without signalling it.

    ``os.kill(pid, 0)`` is not a probe on Windows — CPython maps ``os.kill``
    onto ``TerminateProcess`` there — so the Win32 wait is used instead.
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
    return not _is_zombie(pid)


def _is_zombie(pid: int) -> bool:
    """A parent that exited and was not reaped still answers signal 0 on
    Linux; it runs nothing, so it counts as gone. (This script runs on its
    own, so it reads /proc itself.)"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            return f.read().rpartition(b")")[2].split()[0] == b"Z"
    except (OSError, IndexError):
        return False


def _read_state(path: str | None) -> bytes:
    if not path:
        return b""
    try:
        return Path(path).read_bytes()
    except OSError:
        return b""


def _native_log(args: argparse.Namespace, message: str) -> None:
    """Write to the host's own ``--log`` file, like the real host does.

    Kept separate from ``_log()`` (stderr, which the backend redirects into
    ITS OWN capture file): the whole point of ``--log`` is that it is a
    different file, so this must not also go to stderr.
    """
    if not args.log:
        return
    target = Path(args.log)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(message + "\n")
    except OSError as exc:
        _log(f"fake-host: could not write native log {target}: {exc}")


def _write_state_atomically(path: str | None, payload: bytes) -> None:
    """Temp + rename, so a crash never leaves a half-written state file."""
    if not path:
        return
    target = Path(path)
    tmp = target.with_suffix(target.suffix + ".tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(payload)
        os.replace(tmp, target)
    except OSError as exc:
        _log(f"fake-host: could not write state file: {exc}")


def _float_env(name: str, default: float = 0.0) -> float:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _int_env(name: str, default: int = 0) -> int:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _start_websocket_server() -> tuple[object, int]:
    """Bind a real loopback WebSocket server on an OS-assigned port."""
    from websockets.sync.server import serve

    def handler(connection) -> None:
        try:
            for message in connection:
                connection.send(message)
        except Exception:  # noqa: BLE001 — a dropped client is not an error
            pass

    server = serve(handler, "127.0.0.1", 0)
    port = server.socket.getsockname()[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def _watch_parent(parent_pid: int, stop: threading.Event) -> None:
    while not stop.wait(0.5):
        if not _pid_alive(parent_pid):
            _log(f"fake-host: parent {parent_pid} is gone — exiting")
            os._exit(0)


def _render(args: argparse.Namespace) -> int:
    """``--render``: copy ``--in`` to ``--out`` and print the report line.

    The real host processes the file through the plugin; the audio itself is
    not what the backend route's tests are about, so the copy stands in for it
    — an unchanged body proves the bytes travelled through the host. Exit codes
    and the report's shape are the real ones (see
    ``native/vst-host/src/engine/Render.cpp``): 1 write failed, 2 bad args,
    3 plugin missing, 7 unreadable input.
    """
    if not args.plugin and not args.null_plugin:
        _log("fake-host: --render needs one of --plugin or --null-plugin")
        return 2
    if not args.in_path:
        _log("fake-host: --render needs --in <input.wav>")
        return 2
    if not args.out_path:
        _log("fake-host: --render needs --out <output.wav>")
        return 2
    if args.plugin and not Path(args.plugin).exists():
        _log("fake-host: plugin file not found")
        return 3

    try:
        payload = Path(args.in_path).read_bytes()
    except OSError as exc:
        _log(f"fake-host: could not read {args.in_path}: {exc}")
        return 7

    state = _read_state(args.state_file)

    warnings: list[str] = []
    configured = os.environ.get("FAKE_VST_HOST_RENDER_WARNINGS", "")
    if configured:
        try:
            parsed = json.loads(configured)
        except ValueError:
            parsed = [configured]
        warnings.extend(str(item) for item in parsed)
    if os.environ.get("FAKE_VST_HOST_RENDER_ECHO") == "1":
        # Lets a test read back what the backend actually handed the host.
        warnings.append(f"echo: state-bytes={len(state)}")
        warnings.append(f"echo: plugin-name={args.plugin_name}")
        warnings.append(f"echo: block-size={args.block_size}")
        warnings.append(f"echo: tail-seconds={args.tail_seconds}")
        if args.midi_events:
            lines = Path(args.midi_events).read_text(encoding="ascii").splitlines()
            warnings.append(f"echo: midi-events={len(lines)}")
            warnings.extend(f"echo: midi {line}" for line in lines[:8])
        if args.automation_json:
            curves = json.loads(Path(args.automation_json).read_text(encoding="utf-8"))
            warnings.append(f"echo: automated-params={len(curves)}")
            warnings.extend(
                f"echo: automation {json.dumps(curve, separators=(',', ':'))}"
                for curve in curves[:4]
            )

    try:
        Path(args.out_path).write_bytes(payload)
    except OSError as exc:
        _log(f"fake-host: could not write {args.out_path}: {exc}")
        return 1

    _emit(
        {
            "ok": True,
            "mode": "render",
            "plugin": args.plugin_name or "Fake",
            "input": args.in_path,
            "output": args.out_path,
            "frames_in": len(payload),
            "frames_out": len(payload),
            "warnings": warnings,
        }
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    # Written before anything else, including every early-return branch below:
    # the real host opens its --log file on startup, so a spawn that never
    # reaches "listening" (a forced test exit, missing plugin, a hang that
    # times out) must still leave native diagnostics behind for
    # LiveSessionManager's failure-detail path to read (see live_host.py's
    # ``_log_suffix``).
    _native_log(args, f"fake-host-native: pid={os.getpid()} log={args.log}")

    if args.version:
        _emit({"ev": "version", "version": "fake-vst-host 1.0", "protocol": PROTOCOL})
        return 0
    if args.list:
        _emit({"ev": "plugins", "list": [{"name": "Fake", "category": "Fx"}]})
        return 0
    if args.selftest:
        _emit({"ev": "selftest", "ok": True})
        return 0

    # The class names the plugin file holds: a --plugin-name outside them
    # fails the way the real host does.
    classes = [
        c for c in os.environ.get("FAKE_VST_HOST_CLASS_NAMES", "").split(",") if c
    ]
    if (
        classes
        and args.plugin_name
        and args.plugin_name.casefold() not in {c.casefold() for c in classes}
    ):
        _log(
            f"startup failed (exit 4): no plugin named '{args.plugin_name}' in "
            f"{args.plugin} (it contains: {', '.join(classes)})"
        )
        return 4

    forced_exit = _int_env("FAKE_VST_HOST_EXIT_CODE")
    if forced_exit:
        message = os.environ.get("FAKE_VST_HOST_EXIT_MESSAGE", "")
        if message:
            _log(message)
        return forced_exit

    if args.render:
        return _render(args)

    if not args.plugin:
        _log("fake-host: --plugin is required")
        return 2
    if not Path(args.plugin).exists():
        _log("fake-host: plugin file not found")
        return 3

    stop_watch = threading.Event()
    if args.parent_pid and os.environ.get("FAKE_VST_HOST_WATCH_PARENT") == "1":
        threading.Thread(
            target=_watch_parent, args=(args.parent_pid, stop_watch), daemon=True
        ).start()

    initial_state = _read_state(args.state_file)
    # stderr, so it lands in the log the backend keeps even when this process
    # never reaches the listening line (the spawn-timeout case). The pid is
    # what lets a test prove a timed-out spawn orphaned nothing.
    _log(f"fake-host: pid={os.getpid()} starting")
    _log(
        "fake-host: args plugin_name=%s sample_rate=%d block_size=%d channels=%d"
        % (args.plugin_name, args.sample_rate, args.block_size, args.channels)
    )

    if os.environ.get("FAKE_VST_HOST_HANG") == "1":
        # Never announce a port: this is the spawn-timeout case. Sleep in
        # slices so a terminate() lands promptly.
        while True:
            time.sleep(0.05)

    try:
        server, port = _start_websocket_server()
    except OSError as exc:
        _log(f"fake-host: socket error: {exc}")
        return 6

    delay = _float_env("FAKE_VST_HOST_LISTEN_DELAY")
    if delay > 0:
        time.sleep(delay)

    _emit({"ev": "listening", "port": port, "pid": os.getpid(), "protocol": PROTOCOL})
    # Proof, for the test, that the backend wrote raw_state BEFORE the spawn:
    # only a digest and a length, never the bytes themselves.
    _emit(
        {
            "ev": "state_seen",
            "bytes": len(initial_state),
            "sha1": hashlib.sha1(initial_state).hexdigest(),
        }
    )
    for index in range(_int_env("FAKE_VST_HOST_CHATTER")):
        _emit({"ev": "warning", "text": f"chatter {index} " + "x" * 256})

    ignore_shutdown = os.environ.get("FAKE_VST_HOST_IGNORE_SHUTDOWN") == "1"
    final_state = initial_state + SHUTDOWN_SUFFIX

    while True:
        # readline(), not ``for raw in sys.stdin``: an explicit line read is
        # what makes the shutdown op land the moment the backend writes it.
        raw = sys.stdin.readline()
        if not raw:
            break  # EOF on stdin == shutdown, per the contract
        line = raw.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            _log(f"fake-host: non-JSON stdin line: {line[:80]}")
            continue
        if message.get("op") == "shutdown":
            if ignore_shutdown:
                _log("fake-host: ignoring shutdown (FAKE_VST_HOST_IGNORE_SHUTDOWN)")
                continue
            break

    # Falling out of the loop means either an explicit shutdown or EOF on
    # stdin; the contract treats both the same way.
    if ignore_shutdown:
        while True:
            time.sleep(0.05)

    stop_watch.set()
    _write_state_atomically(args.state_file, final_state)
    try:
        server.shutdown()
    except Exception:  # noqa: BLE001 — teardown must not change the exit code
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
