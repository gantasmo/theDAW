"""Process-management tests for the live VST host session manager.

The native host (``thedaw-vst-host``) is built separately and is normally
absent, so every spawning test points ``THEDAW_VST_HOST`` at
``tests/fake_vst_host.py``, which reproduces the process-facing half of
``docs/design/vst-live-protocol.md``: the same argv, the ``listening`` stdout
line, a real loopback WebSocket, ``{"op":"shutdown"}`` on stdin and the
documented exit codes.

Every test that spawns anything goes through the ``manager`` fixture, which
calls ``kill_all()`` in teardown — no host process may outlive a test.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import live_host as lh  # noqa: E402
from backend.modules.vst import path_policy  # noqa: E402

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An allowed VST3 root (R5-2).

    ``live_host._validate_plugin`` now runs every plugin path through
    ``path_policy.check_plugin_path``, which only accepts a path inside
    ``path_policy.allowed_roots()``. Every plugin path this suite hands to
    ``create()`` for a *successful* spawn has to live under this directory;
    ``path_policy.allowed_roots`` is patched directly, the same thing
    ``tests/test_vst_path_policy.py`` does.
    """
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    return root


@pytest.fixture
def plugin_file(vst3_root: Path) -> Path:
    """A path that passes validation: exists, ends in ``.vst3``, is under
    ``vst3_root``."""
    path = vst3_root / "Ozone 11.vst3"
    path.write_bytes(b"not a real plugin, only the path is validated")
    return path


@pytest.fixture
def plugin_bundle(vst3_root: Path) -> Path:
    """A ``.vst3`` *bundle directory*, the shape macOS/Windows VST3s use."""
    path = vst3_root / "Bundled.vst3"
    (path / "Contents").mkdir(parents=True)
    return path


@pytest.fixture
def fake_host_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))


@pytest.fixture
def no_host_binary(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Make the locator find nothing, whatever this machine has built.

    Pointing ``THEDAW_VST_HOST`` at a missing file is NOT enough on its own:
    the locator's second candidate is ``native/vst-host/bin/thedaw-vst-host``,
    which exists on any machine that has built the host, so the "not built"
    branch would never be reached and the test would assert against a live
    host instead. Both candidates have to land in an empty directory.
    """
    empty = tmp_path / "no-host-here"
    empty.mkdir(exist_ok=True)
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(empty / "missing-host.exe"))
    monkeypatch.setattr(lh, "default_host_path", lambda: empty / lh._HOST_BINARY)
    return empty


@pytest.fixture
def manager(tmp_path: Path, fake_host_env: None):
    """A manager rooted in tmp_path whose sessions are always reaped."""
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", spawn_timeout=20.0)
    try:
        yield mgr
    finally:
        mgr.kill_all()


@pytest.fixture
def client(manager, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The real router mounted at /api/vst, backed by the test manager.

    Starlette's ``TestClient`` reports its TCP peer as ``testclient`` by
    default, not a loopback address; ``client=`` overrides that so these
    tests exercise the legitimate-local-caller path rather than tripping the
    LAN2 loopback gate on ``/live/session``.
    """
    from backend.modules.vst import router as vst_router

    monkeypatch.setattr(lh, "_MANAGER", manager, raising=False)
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("127.0.0.1", 51000))


def make(mgr, plugin: Path, chain_entry_id: str = "entry-1", **kwargs):
    params = {
        "chain_entry_id": chain_entry_id,
        "plugin_path": str(plugin),
        "sample_rate": 48000,
        "block_size": 512,
        "channels": 2,
    }
    params.update(kwargs)
    return mgr.create(**params)


def ws_echo(url: str, payload: str) -> str:
    from websockets.sync.client import connect

    with connect(url, open_timeout=10) as connection:
        connection.send(payload)
        return connection.recv(timeout=10)


def wait_until(predicate, timeout: float = 10.0, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


# ---------------------------------------------------------------------------
# Host discovery
# ---------------------------------------------------------------------------


def test_host_locator_prefers_the_environment_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))
    assert lh.HostLocator().resolve() == FAKE_HOST


def test_host_locator_reports_missing_binary_with_a_reason(
    no_host_binary: Path,
) -> None:
    described = lh.HostLocator().describe()
    assert described["available"] is False
    assert described["reason"]
    assert "thedaw-vst-host" in described["reason"] or "build" in described["reason"]


def test_host_locator_reports_a_version_for_a_present_binary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))
    described = lh.HostLocator().describe()
    assert described["available"] is True
    assert described["version"]


def test_create_without_a_host_binary_is_503(
    no_host_binary: Path, tmp_path: Path, plugin_file: Path
) -> None:
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(mgr, plugin_file)
    assert excinfo.value.status_code == 503
    assert excinfo.value.detail == lh.HostLocator().describe()["reason"]


def test_a_host_binary_that_cannot_be_launched_is_503_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, plugin_file: Path
) -> None:
    """A present-but-unrunnable host: report it, leak no directory, no paths.

    The session directory is created (and its log opened) before ``Popen``, so
    this is the path where a still-open handle would stop Windows from
    removing the directory again.
    """
    bogus = tmp_path / "thedaw-vst-host.exe"
    bogus.write_bytes(b"this is not an executable")
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(bogus))
    root = tmp_path / "vst_live"
    mgr = lh.LiveSessionManager(root=root)
    try:
        with pytest.raises(lh.LiveHostError) as excinfo:
            make(mgr, plugin_file)
    finally:
        mgr.kill_all()

    assert excinfo.value.status_code == 503
    assert [p.name for p in root.iterdir()] in ([], ["logs"])


def test_os_errors_are_reported_without_the_path_they_failed_on() -> None:
    """``str(OSError)`` appends the path, and these paths are the user's data.

    Checked here rather than through a route: whether the OS attaches a
    filename depends on the call (a failed ``CreateProcess`` on Windows does
    not), so only a direct error carries the leak reliably.
    """
    exc = PermissionError(
        13, "Permission denied", r"C:\Users\someone\Music\data\vst_live\abc"
    )
    assert "someone" in str(exc), "the leak this guards against"
    assert lh._os_reason(exc) == "Permission denied"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_missing_plugin_path_is_rejected(manager, vst3_root: Path) -> None:
    # Inside the allowed root (so this exercises the "not found" branch, not
    # the R5-2 containment check) but never created.
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, vst3_root / "Ghost.vst3")
    assert excinfo.value.status_code == 400
    assert "Ghost.vst3" in excinfo.value.detail


def test_non_vst3_extension_is_rejected(manager, tmp_path: Path) -> None:
    path = tmp_path / "plugin.dll"
    path.write_bytes(b"x")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, path)
    assert excinfo.value.status_code == 400
    assert ".vst3" in excinfo.value.detail


def test_a_vst3_bundle_directory_is_accepted(manager, plugin_bundle: Path) -> None:
    session = make(manager, plugin_bundle)
    assert session.port


@pytest.mark.parametrize("sample_rate", [0, 7999, 384001, -48000])
def test_sample_rate_out_of_range_is_rejected(
    manager, plugin_file: Path, sample_rate: int
) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file, sample_rate=sample_rate)
    assert excinfo.value.status_code == 400
    assert "sample_rate" in excinfo.value.detail


@pytest.mark.parametrize("block_size", [0, 100, 384, 4096])
def test_unsupported_block_size_is_rejected(
    manager, plugin_file: Path, block_size: int
) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file, block_size=block_size)
    assert excinfo.value.status_code == 400
    assert "block_size" in excinfo.value.detail


@pytest.mark.parametrize("channels", [0, 9, -2])
def test_channel_count_out_of_range_is_rejected(
    manager, plugin_file: Path, channels: int
) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file, channels=channels)
    assert excinfo.value.status_code == 400
    assert "channels" in excinfo.value.detail


def test_validation_errors_never_leak_the_plugin_directory(
    manager, vst3_root: Path, tmp_path: Path
) -> None:
    # Inside the allowed root, so this reaches the audio-parameter validation
    # (channels=99) rather than being rejected earlier by R5-2's containment
    # check.
    secret = vst3_root / "Private Sessions" / "Secret.vst3"
    secret.parent.mkdir(parents=True)
    secret.write_bytes(b"x")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, secret, channels=99)
    assert "Private Sessions" not in excinfo.value.detail
    # The stronger check: the whole tmp_path, not just the VST3 subdirectory
    # under it, must never appear — a leak via any other path under tmp_path
    # would pass a narrower "vst3_root not in detail" check but not this one.
    assert str(tmp_path) not in excinfo.value.detail


# ---------------------------------------------------------------------------
# Spawning
# ---------------------------------------------------------------------------


def test_create_returns_a_connectable_ws_url(manager, plugin_file: Path) -> None:
    session = make(manager, plugin_file)
    assert session.ws_url == f"ws://127.0.0.1:{session.port}"
    assert session.protocol == 1
    assert session.pid > 0
    assert session.alive is True
    assert ws_echo(session.ws_url, "ping-me") == "ping-me"


def test_spawn_argv_matches_the_contract(manager, plugin_file: Path) -> None:
    session = make(manager, plugin_file, plugin_name="Maximizer")
    argv = session.argv
    assert "--plugin" in argv and argv[argv.index("--plugin") + 1] == str(plugin_file)
    assert argv[argv.index("--plugin-name") + 1] == "Maximizer"
    assert argv[argv.index("--sample-rate") + 1] == "48000"
    assert argv[argv.index("--block-size") + 1] == "512"
    assert argv[argv.index("--channels") + 1] == "2"
    assert argv[argv.index("--port") + 1] == "0"
    assert argv[argv.index("--parent-pid") + 1] == str(os.getpid())
    # An orphaned host (its browser tab died) must exit on its own.
    assert argv[argv.index("--idle-timeout") + 1] == "120"
    assert argv[argv.index("--state-file") + 1] == str(session.state_path)
    # The host's OWN log is a separate file from host.log (stdout pump +
    # stderr) — see the module docstring's "Logs" section.
    assert argv[argv.index("--log") + 1] == str(session.native_log_path)
    assert session.native_log_path != session.log_path
    assert session.native_log_path.name == "host-native.log"


def test_log_tail_reads_the_native_log_before_the_host_log(
    manager, plugin_file: Path
) -> None:
    """The host's own ``--log`` output and the pump/stderr capture are two
    different files; ``log_tail`` must surface the host's native lines first.
    """
    session = make(manager, plugin_file)

    assert wait_until(
        lambda: any("fake-host-native:" in line for line in session.log_tail(200)),
        timeout=10,
    ), "the fake host never wrote its native log"
    assert session.native_log_path.is_file()
    assert session.native_log_path != session.log_path

    tail = session.log_tail(200)
    native_index = next(i for i, line in enumerate(tail) if "fake-host-native:" in line)
    host_index = next(i for i, line in enumerate(tail) if '"listening"' in line)
    assert native_index < host_index, "native log lines must come first"


def test_create_is_idempotent_per_chain_entry(manager, plugin_file: Path) -> None:
    first = make(manager, plugin_file, chain_entry_id="chain-A")
    second = make(manager, plugin_file, chain_entry_id="chain-A")
    assert second.session_id == first.session_id
    assert second.pid == first.pid
    assert len(manager.list()) == 1


def test_swapping_the_plugin_on_a_live_chain_entry_respawns_the_host(
    manager, plugin_file: Path, vst3_root: Path
) -> None:
    """Idempotency is per (chain entry, plugin) — not per chain entry alone.

    The user picking a different plugin in a slot that is already playing has
    to get that plugin. Returning the running session (the old idempotency
    rule) left the previous plugin in the signal path with no way out short of
    a DELETE the frontend never sends.
    """
    other = vst3_root / "Vinyl.vst3"
    other.write_bytes(b"a different plugin")
    first = make(manager, plugin_file, chain_entry_id="slot-1")
    old_pid = first.pid

    second = make(manager, other, chain_entry_id="slot-1")

    assert second.session_id != first.session_id
    assert second.pid != old_pid
    assert second.plugin_path == str(other)
    assert second.alive is True
    # The old host is gone, not merely forgotten: one plugin per slot.
    assert wait_until(lambda: not lh.pid_alive(old_pid), timeout=10)
    assert [s.session_id for s in manager.list() if s.alive] == [second.session_id]


def test_swapping_the_plugin_discards_the_old_plugins_state(
    manager, plugin_file: Path, vst3_root: Path
) -> None:
    """The replaced plugin's state must not be handed to its replacement."""
    other = vst3_root / "Vinyl.vst3"
    other.write_bytes(b"a different plugin")
    first = make(
        manager,
        plugin_file,
        chain_entry_id="slot-1",
        raw_state=base64.b64encode(b"old-plugin-state").decode("ascii"),
    )
    old_dir = first.dir

    second = make(manager, other, chain_entry_id="slot-1")

    assert not old_dir.exists(), "the replaced session's directory was left behind"
    assert not second.state_path.exists(), "the new host inherited the old state"


def test_changing_only_the_plugin_name_also_respawns_the_host(
    manager, plugin_file: Path
) -> None:
    """``plugin_name`` selects a plugin inside a multi-plugin bundle."""
    first = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="Maximizer")

    second = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="Imager")

    assert second.session_id != first.session_id
    assert second.plugin_name == "Imager"
    assert len([s for s in manager.list() if s.alive]) == 1


def test_a_name_the_plugin_does_not_have_starts_its_own_effect(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A chain names its plugin after the file ("FreeGain"); the plugin calls
    itself "Free Gain". The host finds no class by the file's name, and the
    file's own effect starts instead of the row failing."""
    monkeypatch.setenv("FAKE_VST_HOST_CLASS_NAMES", "Free Gain")
    first = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="FreeGain")
    assert first.alive
    assert "--plugin-name" not in first.argv
    # Every rebuild asks again under the same name: still the same plugin.
    again = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="FreeGain")
    assert again.session_id == first.session_id


def test_a_name_the_plugin_has_is_passed_through(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_CLASS_NAMES", "Maximizer,Imager")
    session = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="imager")
    assert session.argv[session.argv.index("--plugin-name") + 1] == "imager"


def test_the_same_plugin_and_name_stay_idempotent(manager, plugin_file: Path) -> None:
    """The play/stop/seek rebuild path must still not respawn anything."""
    first = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="Maximizer")
    second = make(
        manager, plugin_file, chain_entry_id="slot-1", plugin_name="Maximizer"
    )
    assert second.session_id == first.session_id
    assert second.pid == first.pid


def test_empty_plugin_name_then_omitted_name_is_idempotent(
    manager, plugin_file: Path
) -> None:
    """``""`` and omitted both mean "no name" — swapping between the two
    spellings of "nothing" must not respawn the host.
    """
    first = make(manager, plugin_file, chain_entry_id="slot-1", plugin_name="")
    assert first.plugin_name is None

    second = make(manager, plugin_file, chain_entry_id="slot-1")

    assert second.session_id == first.session_id
    assert second.pid == first.pid
    assert second.plugin_name is None
    assert len([s for s in manager.list() if s.alive]) == 1


def test_a_different_chain_entry_gets_its_own_process(
    manager, plugin_file: Path
) -> None:
    first = make(manager, plugin_file, chain_entry_id="chain-A")
    second = make(manager, plugin_file, chain_entry_id="chain-B")
    assert second.session_id != first.session_id
    assert second.pid != first.pid
    assert len(manager.list()) == 2


def test_concurrent_creates_for_one_chain_entry_spawn_one_host(
    manager, plugin_file: Path
) -> None:
    """The invariant the manager lock exists for.

    Without the check and the insert under one lock, every caller passes the
    "is there already a session for this entry?" test, they all spawn, and all
    but one process leaks untracked — the same bug the stems sidecar's spawn
    lock was added for.
    """
    with ThreadPoolExecutor(max_workers=8) as pool:
        sessions = list(
            pool.map(
                lambda _: make(manager, plugin_file, chain_entry_id="race"), range(8)
            )
        )

    assert len({s.session_id for s in sessions}) == 1
    assert len({s.pid for s in sessions}) == 1
    assert len(manager.list()) == 1


def test_concurrent_creates_never_exceed_the_cap(
    tmp_path: Path, plugin_file: Path, fake_host_env: None
) -> None:
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", max_sessions=3)
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(
                pool.map(
                    lambda i: _try_create(mgr, plugin_file, f"entry-{i}"), range(8)
                )
            )
        assert outcomes.count("ok") == 3
        assert outcomes.count(429) == 5
        assert len([s for s in mgr.list() if s.alive]) == 3
    finally:
        mgr.kill_all()


def _try_create(mgr, plugin: Path, chain_entry_id: str):
    try:
        make(mgr, plugin, chain_entry_id=chain_entry_id)
    except lh.LiveHostError as exc:
        return exc.status_code
    return "ok"


def test_raw_state_is_on_disk_before_popen_is_called(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ordering guarantee, checked at the instant of the spawn.

    Asserting this from the host's side does NOT work: a child needs ~100 ms to
    reach its first read, so a state file written straight *after* ``Popen``
    still arrives in time and the test passes while the guarantee is broken
    (verified by mutating the manager). Only a spy on ``Popen`` itself pins the
    order down.
    """
    payload = b"\x00\x01VST3-STATE-BLOB\xff" * 16
    at_spawn: dict[str, object] = {}
    real_popen = subprocess.Popen

    def spy(argv, *args, **kwargs):
        state_file = Path(argv[argv.index("--state-file") + 1])
        at_spawn["exists"] = state_file.is_file()
        at_spawn["bytes"] = state_file.read_bytes() if state_file.is_file() else None
        return real_popen(argv, *args, **kwargs)

    monkeypatch.setattr(lh.subprocess, "Popen", spy)
    session = make(
        manager, plugin_file, raw_state=base64.b64encode(payload).decode("ascii")
    )

    assert at_spawn["exists"] is True, "the host was spawned before its state existed"
    assert at_spawn["bytes"] == payload
    assert session.state_path.read_bytes() == payload


def test_the_host_actually_reads_the_state_it_was_given(
    manager, plugin_file: Path
) -> None:
    """End to end: the bytes the backend wrote are the bytes the host loaded."""
    import hashlib

    payload = b"\x00\x01VST3-STATE-BLOB\xff" * 16
    session = make(
        manager, plugin_file, raw_state=base64.b64encode(payload).decode("ascii")
    )

    # The host reports only a length and a digest of what it read — never the
    # state bytes themselves.
    assert wait_until(lambda: _state_seen(session) is not None, timeout=10), (
        "fake host never reported the state it read at startup"
    )
    reported = _state_seen(session)
    assert reported["bytes"] == len(payload)
    assert reported["sha1"] == hashlib.sha1(payload).hexdigest()


def _state_seen(session) -> dict | None:
    for line in session.log_tail(200):
        if '"state_seen"' not in line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if payload.get("ev") == "state_seen":
            return payload
    return None


def test_invalid_base64_raw_state_is_rejected(manager, plugin_file: Path) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file, raw_state="!!!! not base64 !!!!")
    assert excinfo.value.status_code == 400
    assert "raw_state" in excinfo.value.detail


def test_a_chatty_host_does_not_wedge_on_a_full_pipe(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 512 lines x ~280 bytes is ~140 KiB: more than a pipe buffer holds, so a
    # manager that stopped reading after "listening" would leave the child
    # blocked in write() and the shutdown below would time out.
    monkeypatch.setenv("FAKE_VST_HOST_CHATTER", "512")
    session = make(manager, plugin_file)
    assert ws_echo(session.ws_url, "still-alive") == "still-alive"
    result = manager.delete(session.session_id)
    assert result["exit_code"] == 0


@pytest.mark.parametrize("code", [3, 4, 5, 6])
def test_early_exit_codes_map_to_502_with_a_meaning(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", str(code))
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_MESSAGE", "fake-host: refusing to start")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file)
    assert excinfo.value.status_code == 502
    detail = excinfo.value.detail
    assert lh.EXIT_CODE_MEANINGS[code] in detail
    assert "fake-host: refusing to start" in detail, "log tail must be included"


def test_an_unknown_exit_code_still_reports_the_number(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", "42")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file)
    assert excinfo.value.status_code == 502
    assert "42" in excinfo.value.detail


def test_spawn_timeout_kills_the_host_and_reports_504(
    tmp_path: Path, plugin_file: Path, fake_host_env: None, monkeypatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_HANG", "1")
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", spawn_timeout=1.5)
    try:
        with pytest.raises(lh.LiveHostError) as excinfo:
            make(mgr, plugin_file)
        assert excinfo.value.status_code == 504
        assert mgr.list() == []
    finally:
        mgr.kill_all()


def test_spawn_timeout_leaves_no_process_behind(
    tmp_path: Path, plugin_file: Path, fake_host_env: None, monkeypatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_HANG", "1")
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", spawn_timeout=1.5)
    try:
        with pytest.raises(lh.LiveHostError) as excinfo:
            make(mgr, plugin_file)
    finally:
        mgr.kill_all()
    # The 504's log tail carries the host's own startup line, so the pid it
    # reported can be checked directly: a timed-out spawn must not orphan it.
    found = re.search(r"fake-host: pid=(\d+)", excinfo.value.detail)
    assert found, f"log tail missing from the 504 detail: {excinfo.value.detail!r}"
    assert wait_until(lambda: not lh.pid_alive(int(found.group(1))), timeout=10)


def test_early_exit_detail_includes_the_native_log(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spawn failure's detail must carry the host's OWN ``--log`` output,
    not only the pump/stderr capture — see ``LiveSession.log_tail()`` and the
    module docstring's "Logs" section, which this failure path must mirror.
    """
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", "4")
    with pytest.raises(lh.LiveHostError) as excinfo:
        make(manager, plugin_file)
    assert excinfo.value.status_code == 502
    assert "fake-host-native:" in excinfo.value.detail, (
        f"native log missing from the 502 detail: {excinfo.value.detail!r}"
    )


def test_spawn_timeout_detail_includes_the_native_log(
    tmp_path: Path, plugin_file: Path, fake_host_env: None, monkeypatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_HANG", "1")
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", spawn_timeout=1.5)
    try:
        with pytest.raises(lh.LiveHostError) as excinfo:
            make(mgr, plugin_file)
        assert excinfo.value.status_code == 504
        assert "fake-host-native:" in excinfo.value.detail, (
            f"native log missing from the 504 detail: {excinfo.value.detail!r}"
        )
    finally:
        mgr.kill_all()


def test_session_cap_is_enforced_with_429(
    tmp_path: Path, plugin_file: Path, fake_host_env: None
) -> None:
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", max_sessions=2)
    try:
        make(mgr, plugin_file, chain_entry_id="a")
        make(mgr, plugin_file, chain_entry_id="b")
        with pytest.raises(lh.LiveHostError) as excinfo:
            make(mgr, plugin_file, chain_entry_id="c")
        assert excinfo.value.status_code == 429
        assert "2" in excinfo.value.detail
    finally:
        mgr.kill_all()


def test_session_cap_is_env_overridable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(lh.MAX_SESSIONS_ENV_VAR, "3")
    assert lh.LiveSessionManager(root=tmp_path / "vst_live").max_sessions == 3
    monkeypatch.delenv(lh.MAX_SESSIONS_ENV_VAR)
    assert (
        lh.LiveSessionManager(root=tmp_path / "vst_live").max_sessions
        == lh.DEFAULT_MAX_SESSIONS
    )


# ---------------------------------------------------------------------------
# Lookup, deletion, reaping
# ---------------------------------------------------------------------------


def test_get_unknown_session_is_404(manager) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        manager.get("no-such-session")
    assert excinfo.value.status_code == 404


def test_delete_returns_the_final_state_and_the_process_is_gone(
    manager, plugin_file: Path
) -> None:
    payload = b"initial-state"
    session = make(
        manager, plugin_file, raw_state=base64.b64encode(payload).decode("ascii")
    )
    pid = session.pid

    result = manager.delete(session.session_id)

    assert result["exit_code"] == 0
    assert base64.b64decode(result["raw_state"]) == payload + b"|shutdown"
    assert wait_until(lambda: not lh.pid_alive(pid), timeout=10)
    assert manager.list() == []


def test_delete_returns_null_state_when_the_host_wrote_none(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No raw_state in, and a host that ignores shutdown (so it is force-killed
    # and never writes one out): there is nothing to hand back.
    monkeypatch.setenv("FAKE_VST_HOST_IGNORE_SHUTDOWN", "1")
    manager.shutdown_timeout = 1.0
    session = make(manager, plugin_file)
    assert not session.state_path.exists()

    result = manager.delete(session.session_id)

    assert result["raw_state"] is None


def test_a_host_that_ignores_shutdown_is_force_killed(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_IGNORE_SHUTDOWN", "1")
    manager.shutdown_timeout = 1.0
    session = make(manager, plugin_file)
    pid = session.pid
    started = time.monotonic()
    manager.delete(session.session_id)
    assert wait_until(lambda: not lh.pid_alive(pid), timeout=10)
    assert time.monotonic() - started < 20


def test_delete_unknown_session_is_404(manager) -> None:
    with pytest.raises(lh.LiveHostError) as excinfo:
        manager.delete("ghost")
    assert excinfo.value.status_code == 404


def test_reaper_marks_a_crashed_session_dead_and_keeps_its_log(
    manager, plugin_file: Path
) -> None:
    session = make(manager, plugin_file)
    session.proc.kill()
    session.proc.wait(timeout=10)

    manager.reap()

    dead = manager.get(session.session_id)
    assert dead.alive is False
    assert dead.exit_code is not None
    assert dead.ended_at is not None
    assert any("listening" in line for line in dead.log_tail(200))


def test_a_dead_session_frees_its_chain_entry_for_a_new_spawn(
    manager, plugin_file: Path
) -> None:
    first = make(manager, plugin_file, chain_entry_id="chain-A")
    first.proc.kill()
    first.proc.wait(timeout=10)
    manager.reap()

    second = make(manager, plugin_file, chain_entry_id="chain-A")

    assert second.session_id != first.session_id
    assert second.alive is True


def test_dead_sessions_are_purged_after_their_grace_period(
    manager, plugin_file: Path
) -> None:
    session = make(manager, plugin_file)
    session.proc.kill()
    session.proc.wait(timeout=10)
    manager.reap()
    assert manager.get(session.session_id).alive is False

    # Ten minutes later (the window the frontend has to recover the sound).
    session.ended_at = time.time() - (lh.DEAD_SESSION_TTL + 1)
    manager.reap()

    with pytest.raises(lh.LiveHostError) as excinfo:
        manager.get(session.session_id)
    assert excinfo.value.status_code == 404


def test_ttl_purge_archives_the_native_log_too(manager, plugin_file: Path) -> None:
    """The periodic sweep's TTL purge is a fourth teardown path that must
    archive both logs, same as an explicit ``delete()``.
    """
    session = make(manager, plugin_file)
    assert wait_until(lambda: session.native_log_path.is_file(), timeout=10)
    session.proc.kill()
    session.proc.wait(timeout=10)
    manager.reap()
    session.ended_at = time.time() - (lh.DEAD_SESSION_TTL + 1)

    manager.reap()

    archived_native = manager.archive_dir / f"{session.session_id}-native.log"
    assert archived_native.is_file()


def test_reap_timer_is_not_started_until_a_session_exists(
    tmp_path: Path, fake_host_env: None
) -> None:
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", reap_interval=0.05)
    assert mgr._reap_timer is None


def test_periodic_reap_purges_an_expired_session_and_then_stops_itself(
    tmp_path: Path, plugin_file: Path, fake_host_env: None
) -> None:
    """The sweep must run on its own — nobody in this test calls ``reap()``
    — and stop rescheduling once the manager is empty again.
    """
    mgr = lh.LiveSessionManager(root=tmp_path / "vst_live", reap_interval=0.05)
    try:
        session = make(mgr, plugin_file)
        assert mgr._reap_timer is not None
        session.proc.kill()
        session.proc.wait(timeout=10)

        # Nobody calls .reap() here: a tick of the sweep itself must notice
        # the crash (the same object session refers to is the one the
        # manager mutates, so this observes the sweep's own work).
        assert wait_until(lambda: session.alive is False, timeout=5), (
            "the periodic sweep never noticed the crashed session"
        )
        # Already past DEAD_SESSION_TTL, so the very next tick purges it.
        session.ended_at = time.time() - (lh.DEAD_SESSION_TTL + 1)

        assert wait_until(lambda: mgr.list() == [], timeout=5), (
            "the periodic sweep never purged the expired session"
        )
        assert wait_until(lambda: mgr._reap_timer is None, timeout=5), (
            "the sweep must stop itself once no session remains"
        )
    finally:
        mgr.kill_all()


def test_reap_retries_a_directory_it_could_not_remove(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A directory ``_remove_tree`` could not fully clear (e.g. a file still
    open on Windows) must be retried by a later reap, not abandoned.
    """
    session = make(manager, plugin_file)
    session.proc.kill()
    session.proc.wait(timeout=10)
    manager.reap()  # notice the crash first (mirrors the TTL-purge test above)
    session.ended_at = time.time() - (lh.DEAD_SESSION_TTL + 1)

    real_remove_tree = lh._remove_tree
    attempts: list[Path] = []

    def flaky_remove_tree(directory: Path) -> bool:
        attempts.append(directory)
        if len(attempts) == 1:
            return False  # simulate a file rmtree could not clear yet
        return real_remove_tree(directory)

    monkeypatch.setattr(lh, "_remove_tree", flaky_remove_tree)

    manager.reap()
    assert session.dir in manager._pending_removal
    assert session.dir.exists(), "must not be treated as removed after a failure"

    manager.reap()

    assert session.dir not in manager._pending_removal
    assert not session.dir.exists()
    assert len(attempts) == 2


def test_kill_all_stops_every_session(manager, plugin_file: Path) -> None:
    pids = [
        make(manager, plugin_file, chain_entry_id=f"chain-{i}").pid for i in range(3)
    ]
    manager.kill_all()
    for pid in pids:
        assert wait_until(lambda p=pid: not lh.pid_alive(p), timeout=10)
    assert manager.list() == []


def test_kill_all_lets_each_host_save_its_state_first(
    manager, plugin_file: Path
) -> None:
    """Backend shutdown must not cost the user what they dialled in.

    ``kill_all`` asks every host to shut down (which makes it write its state
    file) before any signal is sent; only a host that ignores that is killed.
    """
    payload = b"dialled-in"
    session = make(
        manager, plugin_file, raw_state=base64.b64encode(payload).decode("ascii")
    )

    manager.kill_all()

    assert session.exit_code == 0, "the host was signalled instead of asked to stop"
    assert base64.b64decode(session.final_state_b64) == payload + b"|shutdown"


def test_kill_all_still_kills_a_host_that_ignores_shutdown(
    manager, plugin_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_VST_HOST_IGNORE_SHUTDOWN", "1")
    manager.shutdown_timeout = 1.0
    pid = make(manager, plugin_file).pid
    manager.kill_all()
    assert wait_until(lambda: not lh.pid_alive(pid), timeout=10)


def test_kill_all_is_safe_to_call_twice(manager, plugin_file: Path) -> None:
    make(manager, plugin_file)
    manager.kill_all()
    manager.kill_all()
    assert manager.list() == []


def test_kill_all_stops_the_reap_timer(manager, plugin_file: Path) -> None:
    make(manager, plugin_file)
    assert manager._reap_timer is not None

    manager.kill_all()

    assert manager._reap_timer is None


def test_session_directory_is_removed_but_the_log_is_archived(
    manager, plugin_file: Path
) -> None:
    session = make(manager, plugin_file)
    session_dir = session.dir
    manager.delete(session.session_id)
    assert not session_dir.exists()
    archived = manager.archive_dir / f"{session.session_id}.log"
    assert archived.is_file()
    assert "listening" in archived.read_text(encoding="utf-8", errors="replace")


def test_session_directory_is_removed_but_the_native_log_is_archived_too(
    manager, plugin_file: Path
) -> None:
    """The host's own ``--log`` output must survive teardown alongside the
    pump/stderr capture — its whole purpose is to outlive the session
    directory (see ``_archive_log``'s docstring), and before this fix it
    was archived nowhere.
    """
    session = make(manager, plugin_file)
    assert wait_until(lambda: session.native_log_path.is_file(), timeout=10)
    manager.delete(session.session_id)

    archived_native = manager.archive_dir / f"{session.session_id}-native.log"
    assert archived_native.is_file()
    assert "fake-host-native:" in archived_native.read_text(
        encoding="utf-8", errors="replace"
    )


def test_archived_logs_are_capped_at_fifty(manager) -> None:
    manager.archive_dir.mkdir(parents=True, exist_ok=True)
    for index in range(60):
        path = manager.archive_dir / f"old-{index:03d}.log"
        path.write_text(f"log {index}\n", encoding="utf-8")
        os.utime(path, (1_700_000_000 + index, 1_700_000_000 + index))

    manager.prune_archived_logs()

    remaining = sorted(p.name for p in manager.archive_dir.glob("*.log"))
    assert len(remaining) == lh.LOG_ARCHIVE_LIMIT
    assert "old-059.log" in remaining
    assert "old-000.log" not in remaining


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def test_http_host_endpoint_reports_availability(client: TestClient) -> None:
    response = client.get("/api/vst/live/host")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["path"]


def test_http_create_get_list_and_delete(client: TestClient, plugin_file: Path) -> None:
    created = client.post(
        "/api/vst/live/session",
        json={
            "chain_entry_id": "entry-http",
            "plugin_path": str(plugin_file),
            "sample_rate": 48000,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["ws_url"].startswith("ws://127.0.0.1:")
    assert body["protocol"] == 1
    session_id = body["session_id"]

    fetched = client.get(f"/api/vst/live/session/{session_id}")
    assert fetched.status_code == 200
    detail = fetched.json()
    assert detail["alive"] is True
    assert detail["pid"] == body["pid"]
    assert detail["port"] == int(body["ws_url"].rsplit(":", 1)[1])
    assert detail["started_at"] > 0
    assert isinstance(detail["log_tail"], list)

    listed = client.get("/api/vst/live/sessions")
    assert listed.status_code == 200
    assert [s["session_id"] for s in listed.json()["sessions"]] == [session_id]

    removed = client.delete(f"/api/vst/live/session/{session_id}")
    assert removed.status_code == 200
    assert removed.json()["session_id"] == session_id
    assert client.get("/api/vst/live/sessions").json()["sessions"] == []


def test_http_create_is_idempotent_per_chain_entry(
    client: TestClient, plugin_file: Path
) -> None:
    payload = {
        "chain_entry_id": "entry-same",
        "plugin_path": str(plugin_file),
        "sample_rate": 44100,
    }
    first = client.post("/api/vst/live/session", json=payload).json()
    second = client.post("/api/vst/live/session", json=payload).json()
    assert first["session_id"] == second["session_id"]
    assert len(client.get("/api/vst/live/sessions").json()["sessions"]) == 1


def test_http_unknown_session_is_404(client: TestClient) -> None:
    assert client.get("/api/vst/live/session/nope").status_code == 404
    assert client.delete("/api/vst/live/session/nope").status_code == 404


def test_http_missing_host_binary_is_503_with_the_host_reason(
    client: TestClient, plugin_file: Path, no_host_binary: Path
) -> None:
    # ``no_host_binary`` is requested AFTER ``client`` on purpose: the client's
    # manager fixture points the env var at the fake host, and this one has to
    # win, so the route sees a machine with no host built at all.
    response = client.post(
        "/api/vst/live/session",
        json={
            "chain_entry_id": "entry-503",
            "plugin_path": str(plugin_file),
            "sample_rate": 48000,
        },
    )
    assert response.status_code == 503
    assert (
        response.json()["detail"] == client.get("/api/vst/live/host").json()["reason"]
    )


def test_http_rejects_a_bad_block_size(client: TestClient, plugin_file: Path) -> None:
    response = client.post(
        "/api/vst/live/session",
        json={
            "chain_entry_id": "entry-bad",
            "plugin_path": str(plugin_file),
            "sample_rate": 48000,
            "block_size": 999,
        },
    )
    assert response.status_code in (400, 422)


def test_existing_vst_routes_are_untouched(client: TestClient) -> None:
    """The /live/* routes are additive: the pre-existing ones still answer."""
    assert client.get("/api/vst/builtin").status_code == 200


# ---------------------------------------------------------------------------
# The fake host itself — if it lies, every test above is meaningless
# ---------------------------------------------------------------------------


def test_fake_host_reports_a_version_and_exits_zero() -> None:
    done = subprocess.run(
        [sys.executable, str(FAKE_HOST), "--version"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 0
    assert json.loads(done.stdout.strip())["version"]


def test_fake_host_exits_2_on_bad_args() -> None:
    done = subprocess.run(
        [sys.executable, str(FAKE_HOST), "--not-a-flag"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 2


def test_fake_host_exits_3_when_the_plugin_is_missing(tmp_path: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(FAKE_HOST), "--plugin", str(tmp_path / "nope.vst3")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert done.returncode == 3


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", 120),
        ("0", 0),
        ("45", 45),
        ("86400", 86400),
        ("86401", 120),
        ("-5", 120),
        ("soon", 120),
    ],
)
def test_idle_timeout_env_override_is_bounded(
    monkeypatch, raw: str, expected: int
) -> None:
    from backend.modules.vst import live_host

    monkeypatch.setenv("THEDAW_VST_LIVE_IDLE_SEC", raw)
    assert live_host._idle_timeout_sec() == expected
