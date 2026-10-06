"""native/vst-host/build.ps1 on the machine it failed on.

Two setup bugs, reported 2026-09-22, both reproduced here with the real tools:

* The script passed ``-A x64`` and no ``-G``. A CMake whose default generator
  is Ninja (the WinLibs build of CMake is one) rejects a platform argument, the
  configure failed, and the failed configure left a Ninja cache in the build
  tree that CMake then refused to reconfigure with any other generator.
* The host compiles with ``/Zc:preprocessor`` and ``/WX``. winbase.h in Windows
  SDK 10.0.19041 expands a macro to ``defined``, the conforming preprocessor
  reports that as C5105, and /WX made it a failed build.

The VST3 layer those builds link had passed /WX only by switching warnings
off: /wd4324 for the ring's padded indices, a C4996 pragma around a vendored
header's strcpy, and _CRT_SECURE_NO_WARNINGS on the host. None is left, and the
layer still has to compile clean.

Windows only, and only with CMake and the Visual Studio C++ build tools
present. Everything is built under pytest's tmp_path; ``-ConfigureOnly`` never
compiles or copies into ``native/vst-host/bin``, and the compile step builds the
host target inside the same temporary tree.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HOST = REPO_ROOT / "native" / "vst-host"
VSWHERE = (
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    / "Microsoft Visual Studio"
    / "Installer"
    / "vswhere.exe"
)


def _have_msvc() -> bool:
    if sys.platform != "win32" or not VSWHERE.is_file():
        return False
    done = subprocess.run(
        [
            str(VSWHERE),
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
        capture_output=True,
        text=True,
    )
    return bool(done.stdout.strip())


pytestmark = pytest.mark.skipif(  # portability: builds the host with MSVC; the Linux build has no CI toolchain
    sys.platform != "win32"
    or shutil.which("cmake") is None
    or shutil.which("powershell") is None
    or not _have_msvc(),
    reason="needs Windows, CMake and the Visual Studio C++ build tools",
)


def _env_without_generator() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("CMAKE_GENERATOR", None)
    return env


def test_build_ps1_configures_and_the_host_compiles_clean_after_a_ninja_failure(
    tmp_path: Path,
):
    # One letter: MSBuild's try-compile logs nest over 100 characters below
    # the build tree, and past 260 in all FileTracker fails with FTK1011.
    build = tmp_path / "b"

    # What the old script ran on a CMake whose default is Ninja: -A with the
    # Ninja generator. It fails and leaves CMAKE_GENERATOR=Ninja in the cache.
    failed = subprocess.run(
        ["cmake", "-S", str(HOST), "-B", str(build), "-G", "Ninja", "-A", "x64"],
        capture_output=True,
        text=True,
        env=_env_without_generator(),
    )
    assert failed.returncode != 0
    cache = (build / "CMakeCache.txt").read_text(encoding="utf-8", errors="replace")
    assert "CMAKE_GENERATOR:INTERNAL=Ninja" in cache

    configured = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(HOST / "build.ps1"),
            "-ConfigureOnly",
            "-Vst3",
            "OFF",
            "-BuildDir",
            str(build),
        ],
        capture_output=True,
        text=True,
        env=_env_without_generator(),
        timeout=300,
    )
    assert configured.returncode == 0, configured.stdout + configured.stderr
    assert "generator: Visual Studio" in configured.stdout

    # /Zc:preprocessor and /WX stay on; the build must still be clean on the
    # installed Windows SDK, whatever its version.
    built = subprocess.run(
        [
            "cmake",
            "--build",
            str(build),
            "--config",
            "Release",
            "--parallel",
            "--target",
            "thedaw-vst-host",
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    log = built.stdout + built.stderr
    assert built.returncode == 0, log[-4000:]
    assert "C5105" not in log
    assert (build / "Release" / "thedaw-vst-host.exe").is_file()


def _newest_visual_studio_cmake_knows() -> str:
    """The generator build.ps1 has to pick: the newest Visual Studio with the
    C++ toolset whose generator this cmake lists."""
    listed = subprocess.run(
        [
            str(VSWHERE),
            "-utf8",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-format",
            "json",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    versions = sorted(
        (
            tuple(int(part) for part in vs["installationVersion"].split("."))
            for vs in json.loads(listed.stdout)
        ),
        reverse=True,
    )
    known = subprocess.run(["cmake", "--help"], capture_output=True, text=True).stdout
    for version in versions:
        hit = re.search(rf"Visual Studio {version[0]} \d{{4}}", known)
        if hit:
            return hit.group(0)
    pytest.skip("this cmake has no generator for any installed Visual Studio")


def test_build_ps1_names_the_newest_visual_studio_the_way_cmake_spells_it(
    tmp_path: Path,
):
    """vswhere reports Visual Studio 2026 with productLineVersion "18", where
    2019 and 2022 report the year. A generator name built from that field,
    "Visual Studio 18 18", is one no cmake has: the 2026 install was passed over
    for an older one, and a machine with no other stopped at "cmake is too old".

    Only the generator line is read. The script prints it before it configures,
    so this holds on a machine whose compiler cannot configure the tree."""
    expected = _newest_visual_studio_cmake_knows()
    done = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(HOST / "build.ps1"),
            "-ConfigureOnly",
            "-Vst3",
            "OFF",
            "-BuildDir",
            str(tmp_path / "b"),
        ],
        capture_output=True,
        text=True,
        env=_env_without_generator(),
        timeout=300,
    )
    assert f"generator: {expected}\n" in done.stdout, done.stdout + done.stderr


def test_the_host_keeps_the_conforming_preprocessor_and_warnings_as_errors():
    """The fix is not to switch either off: both flags stay in the host's
    compile options."""
    text = (HOST / "CMakeLists.txt").read_text(encoding="utf-8")
    assert "/Zc:preprocessor" in text
    assert "target_compile_options(thedaw-vst-host PRIVATE /WX)" in text
    assert "/wd5105" not in text.lower()


def _warning_switches_off() -> list[str]:
    """Every place under native/vst-host, vendored headers aside, that turns a
    compiler warning off instead of removing its cause."""
    found: list[str] = []
    for path in sorted(HOST.rglob("*")):
        if not path.is_file() or "third_party" in path.parts:
            continue
        if path.suffix not in {".cpp", ".h", ".hpp", ".txt", ".cmake", ".ps1"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            low = line.lower()
            if (
                "/wd" in low
                or "warning(disable" in low
                or "_crt_secure_no_warnings" in low
            ):
                found.append(f"{path.relative_to(HOST)}:{number}: {line.strip()}")
    return found


def test_the_vst3_layer_compiles_at_w4_wx_with_no_warning_switched_off(tmp_path: Path):
    """setup.ps1 builds the host with the VST3 layer ON and warnings as errors.
    The layer built only because /wd4324 and a C4996 pragma switched two
    warnings off; the build has to pass with neither."""
    assert _warning_switches_off() == []

    build = tmp_path / "b"
    configured = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(HOST / "build.ps1"),
            "-ConfigureOnly",
            "-Vst3",
            "ON",
            "-BuildDir",
            str(build),
        ],
        capture_output=True,
        text=True,
        env=_env_without_generator(),
        timeout=300,
    )
    assert configured.returncode == 0, configured.stdout + configured.stderr

    built = subprocess.run(
        [
            "cmake",
            "--build",
            str(build),
            "--config",
            "Release",
            "--parallel",
            "--target",
            "thedaw_vst3",
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    log = built.stdout + built.stderr
    assert built.returncode == 0, log[-4000:]
    assert "warning C" not in log, log[-4000:]
