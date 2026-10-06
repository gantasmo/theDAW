"""The VJ sidecar's own ``npm install`` takes sharp's prebuilt binary.

sharp, a dependency of VJ-9000, skips its prebuilt binary and builds from
source whenever pkg-config finds a system libvips, which a Linux desktop often
has. That build stops at a missing node-addon-api, the install fails, and the
VJ tab never starts. It was reported against the Pinokio launcher's install
(gantasmo/theDAW-Pinokio#5); the backend makes the same install on the first
use of the VJ tab when the checkout has no ``node_modules``.

No test here runs npm: the spawn is replaced and only its environment is read.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.lib import launch_token
from backend.modules.vj import sidecar

SECRET = "launch-secret-for-tests"
PROBE = "THEDAW_CHILD_ENV_PROBE"


@pytest.fixture(autouse=True)
def environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(launch_token.ENV_VAR, SECRET)
    monkeypatch.setenv(PROBE, "kept")
    monkeypatch.delenv("SHARP_IGNORE_GLOBAL_LIBVIPS", raising=False)
    monkeypatch.delenv("SHARP_FORCE_GLOBAL_LIBVIPS", raising=False)


def test_the_install_environment_tells_sharp_to_skip_the_system_libvips() -> None:
    env = sidecar._npm_install_env()
    assert env["SHARP_IGNORE_GLOBAL_LIBVIPS"] == "1"
    assert env[PROBE] == "kept"
    assert launch_token.ENV_VAR not in {name.upper() for name in env}
    assert SECRET not in env.values()


def test_a_forced_system_libvips_is_left_as_the_user_set_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # sharp reads IGNORE before FORCE, so adding IGNORE would undo the choice.
    monkeypatch.setenv("SHARP_FORCE_GLOBAL_LIBVIPS", "1")
    env = sidecar._npm_install_env()
    assert "SHARP_IGNORE_GLOBAL_LIBVIPS" not in env
    assert env["SHARP_FORCE_GLOBAL_LIBVIPS"] == "1"


def test_the_first_run_install_is_started_with_that_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "vj"
    project.mkdir()
    config = sidecar.VJConfig(
        project_path=project,
        port=5187,
        npm_path="npm",
        node_path="node",
        dev_mode=False,
    )
    monkeypatch.setattr(sidecar, "resolve_config", lambda: config)
    monkeypatch.setattr(sidecar, "_port_is_listening", lambda *_a, **_k: False)
    monkeypatch.setattr(sidecar, "_proc", None)
    monkeypatch.setattr(sidecar, "_resolved_url", None)
    monkeypatch.setattr(sidecar, "SIDECAR_LOG_PATH", tmp_path / "vj-sidecar.log")

    started: list[tuple[Any, dict[str, str] | None]] = []

    def failing_install(*args: Any, **kwargs: Any) -> int:
        started.append((args[0], kwargs.get("env")))
        return 1

    monkeypatch.setattr(sidecar.subprocess, "call", failing_install)

    # The install "fails", so ensure_running stops before it starts the server.
    with pytest.raises(RuntimeError, match="npm install failed"):
        sidecar.ensure_running(wait_for_ready=False)

    [(command, env)] = started
    assert command == ["npm", "install"]
    assert env is not None
    assert env["SHARP_IGNORE_GLOBAL_LIBVIPS"] == "1"
    assert launch_token.ENV_VAR not in {name.upper() for name in env}
