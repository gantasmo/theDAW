"""Toolchain detection for the Chimera module.

Result is cached on first probe so repeated /probe hits are cheap. Pass
force=True to re-detect (e.g., if the user installs ffmpeg without
restarting the server).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from typing import Optional, TypedDict

log = logging.getLogger(__name__)


class ToolchainStatus(TypedDict):
    aubio: bool
    aubio_source: Optional[str]
    ffmpeg: bool
    librubberband: bool
    versions: dict[str, Optional[str]]
    install_hint: Optional[str]


_cached: Optional[ToolchainStatus] = None


def _run(cmd: list[str], timeout: float = 5.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        log.debug("probe cmd %s failed: %s", cmd, e)
        return -1, ""


def _first_line(s: str) -> Optional[str]:
    for ln in s.splitlines():
        stripped = ln.strip()
        if stripped:
            return stripped
    return None


def _detect_aubio() -> tuple[bool, Optional[str], Optional[str]]:
    cli = shutil.which("aubio")
    if cli:
        code, out = _run([cli, "--help"])
        # aubio CLI usually prints help and exits 0; some builds exit 1 but
        # still print help. Treat both as "present" and let downstream use fail
        # loudly with a meaningful error.
        if code in (0, 1) and out:
            return True, "cli", _first_line(out)
        if code == 0:
            return True, "cli", None
    try:
        import aubio  # type: ignore

        version = getattr(aubio, "__version__", None) or getattr(aubio, "version", None)
        return True, "python", version
    except ImportError:
        pass
    return False, None, None


def _detect_ffmpeg() -> tuple[bool, bool, Optional[str]]:
    if not shutil.which("ffmpeg"):
        return False, False, None
    code, out = _run(["ffmpeg", "-version"])
    if code != 0:
        return False, False, None
    version = _first_line(out)
    code, filters = _run(["ffmpeg", "-hide_banner", "-filters"])
    librubberband = code == 0 and "rubberband" in filters.lower()
    return True, librubberband, version


def _build_hint(aubio_ok: bool, ffmpeg_ok: bool, rb_ok: bool) -> Optional[str]:
    parts: list[str] = []
    if not ffmpeg_ok:
        parts.append("ffmpeg")
    elif not rb_ok:
        parts.append(
            "ffmpeg built with librubberband (default ffmpeg often lacks it; use "
            "gyan.dev ffmpeg-full on Windows, `brew install ffmpeg` on macOS, or "
            "a BtbN static build on Linux)"
        )
    if not aubio_ok:
        parts.append(
            "optional aubio (install via your package manager for faster tempo detection; "
            "librosa fallback still works)"
        )
    if not parts:
        return None
    return "Missing: " + "; ".join(parts)


def probe(force: bool = False) -> ToolchainStatus:
    global _cached
    if _cached is not None and not force:
        return _cached
    aubio_ok, aubio_source, aubio_ver = _detect_aubio()
    ffmpeg_ok, rb_ok, ffmpeg_ver = _detect_ffmpeg()
    _cached = {
        "aubio": aubio_ok,
        "aubio_source": aubio_source,
        "ffmpeg": ffmpeg_ok,
        "librubberband": rb_ok,
        "versions": {"aubio": aubio_ver, "ffmpeg": ffmpeg_ver},
        "install_hint": _build_hint(aubio_ok, ffmpeg_ok, rb_ok),
    }
    log.info(
        "chimera toolchain probe: aubio=%s ffmpeg=%s librubberband=%s",
        aubio_ok,
        ffmpeg_ok,
        rb_ok,
    )
    return _cached
