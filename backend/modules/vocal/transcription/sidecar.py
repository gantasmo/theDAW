"""faster-whisper transcription sidecar (isolated venv, one-shot CLI).

Transcription needs faster-whisper (CTranslate2), kept OUT of the main app
environment. This module bootstraps a dedicated venv next to worker.py, installs
faster-whisper into it on demand (uv first, pip fallback), and runs worker.py as
a one-shot subprocess that returns word-timed segments as JSON. faster-whisper is
NEVER imported in the main process; only the worker (inside the isolated venv)
imports it, so server startup stays cheap.

Defaults to CPU int8 so it runs without any CUDA/cuDNN DLLs. Override via
theDAW_WHISPER_DEVICE / theDAW_WHISPER_COMPUTE / theDAW_WHISPER_MODEL, or point at
an existing interpreter with theDAW_WHISPER_PYTHON. The venv location is
configurable with theDAW_WHISPER_VENV_DIR (default: next to this file).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

_PACKAGE_DIR = Path(__file__).resolve().parent
_WORKER = _PACKAGE_DIR / "worker.py"
_REQUIREMENTS = _PACKAGE_DIR / "requirements.txt"
SIDECAR_VENV_DIRNAME = ".whisper_venv"
_CRITICAL_PACKAGES: tuple[str, ...] = ("faster_whisper",)
_INSTALL_TIMEOUT_SEC = 20 * 60
_TRANSCRIBE_TIMEOUT_SEC = 30 * 60


def _venv_python(base: Path) -> Path:
    venv_dir = base / SIDECAR_VENV_DIRNAME
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


@dataclass
class WhisperConfig:
    venv_base: Path
    python_exe: Path
    model: str
    device: str
    compute_type: str


def resolve_config() -> WhisperConfig:
    base_env = os.getenv("theDAW_WHISPER_VENV_DIR")
    venv_base = Path(base_env).expanduser().resolve() if base_env else _PACKAGE_DIR
    py = os.getenv("theDAW_WHISPER_PYTHON")
    python_exe = Path(py).expanduser().resolve() if py else _venv_python(venv_base)
    return WhisperConfig(
        venv_base=venv_base,
        python_exe=python_exe,
        model=os.getenv("theDAW_WHISPER_MODEL", "small"),
        device=os.getenv("theDAW_WHISPER_DEVICE", "cpu"),
        compute_type=os.getenv("theDAW_WHISPER_COMPUTE", "int8"),
    )


def _probe_packages(python_exe: Path) -> dict:
    """Import faster_whisper in the sidecar Python in ONE subprocess. Cheap,
    never raises; returns {pkg: {ok, version|error}} or {_error: ...}."""
    script = (
        "import json, importlib\n"
        f"pkgs = {list(_CRITICAL_PACKAGES)!r}\n"
        "out = {}\n"
        "for p in pkgs:\n"
        "    try:\n"
        "        m = importlib.import_module(p)\n"
        "        out[p] = {'ok': True, 'version': getattr(m, '__version__', None)}\n"
        "    except Exception as e:\n"
        "        out[p] = {'ok': False, 'error': repr(e)[:300]}\n"
        "print(json.dumps(out))\n"
    )
    try:
        result = subprocess.run(
            [str(python_exe), "-c", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return {"_error": repr(e)}
    if result.returncode != 0:
        return {"_error": result.stderr.strip()[:300] or "probe subprocess failed"}
    try:
        return json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as e:
        return {"_error": f"probe parse failed: {e}"}


def probe(cfg: Optional[WhisperConfig] = None) -> dict:
    """Non-spawning health snapshot for the UI: is the venv built and can it
    import faster-whisper?"""
    cfg = cfg or resolve_config()
    venv_dir = cfg.python_exe.parent.parent
    out: dict = {
        "ok": False,
        "python_exe": str(cfg.python_exe),
        "python_exe_exists": cfg.python_exe.is_file(),
        "sidecar_venv": str(venv_dir),
        "sidecar_venv_exists": venv_dir.exists(),
        "worker_exists": _WORKER.is_file(),
        "model": cfg.model,
        "device": cfg.device,
        "compute_type": cfg.compute_type,
        "packages": {},
        "missing_critical": list(_CRITICAL_PACKAGES),
        "critical_ok": False,
    }
    if cfg.python_exe.is_file():
        pkgs = _probe_packages(cfg.python_exe)
        if "_error" in pkgs:
            out["error"] = pkgs["_error"]
        else:
            out["packages"] = pkgs
            out["missing_critical"] = [
                p for p in _CRITICAL_PACKAGES if not pkgs.get(p, {}).get("ok")
            ]
            out["critical_ok"] = len(out["missing_critical"]) == 0
    else:
        out["error"] = f"sidecar venv not created yet: {cfg.python_exe}"
    out["ok"] = out["critical_ok"] and out["worker_exists"]
    return out


def available() -> bool:
    try:
        return bool(probe().get("critical_ok"))
    except Exception as e:
        log.info("vocal.whisper: availability probe failed: %s", e)
        return False


def _bootstrap_venv(cfg: WhisperConfig) -> dict:
    """Create the isolated venv on demand (uv venv --seed, stdlib venv fallback)."""
    venv_dir = cfg.python_exe.parent.parent
    if cfg.python_exe.is_file():
        return {"ok": True, "created": False, "tool": "existing"}
    venv_dir.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["uv", "venv", str(venv_dir), "--python", sys.executable, "--seed"],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode == 0 and cfg.python_exe.is_file():
            return {"ok": True, "created": True, "tool": "uv"}
    except (OSError, subprocess.TimeoutExpired) as e:
        log.info("vocal.whisper: uv venv unavailable (%s), falling back", e)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "venv", str(venv_dir)],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "created": False, "tool": "venv", "error": repr(e)}
    return {
        "ok": result.returncode == 0 and cfg.python_exe.is_file(),
        "created": True,
        "tool": "venv",
        "stderr": result.stderr[-2000:],
    }


def _install_cmd(python_exe: Path, req: Path) -> tuple[list[str], str]:
    """Prefer `uv pip install --python <exe>` (host project is uv-based); fall
    back to the venv's own pip."""
    try:
        uv_check = subprocess.run(
            ["uv", "--version"], capture_output=True, text=True, timeout=10
        )
        if uv_check.returncode == 0:
            return (
                ["uv", "pip", "install", "--python", str(python_exe), "-r", str(req)],
                "uv-pip",
            )
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ([str(python_exe), "-m", "pip", "install", "-r", str(req)], "pip")


def install_dependencies(cfg: Optional[WhisperConfig] = None) -> dict:
    """Bootstrap the isolated venv then install faster-whisper into it."""
    cfg = cfg or resolve_config()
    out: dict = {"ok": False, "python_exe": str(cfg.python_exe)}
    if not _REQUIREMENTS.is_file():
        out["error"] = f"requirements.txt not found at {_REQUIREMENTS}"
        return out
    bootstrap = _bootstrap_venv(cfg)
    out["venv_bootstrap"] = bootstrap
    if not bootstrap.get("ok"):
        out["error"] = (
            "could not create whisper venv at "
            f"{cfg.python_exe.parent.parent}: "
            f"{bootstrap.get('stderr', bootstrap.get('error', '?'))}"
        )
        return out
    try:
        argv, mode = _install_cmd(cfg.python_exe, _REQUIREMENTS)
        out["install_mode"] = mode
        result = subprocess.run(
            argv, capture_output=True, text=True, timeout=_INSTALL_TIMEOUT_SEC
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        out["error"] = repr(e)
        return out
    out["returncode"] = result.returncode
    out["stdout"] = result.stdout[-4000:]
    out["stderr"] = result.stderr[-4000:]
    out["ok"] = result.returncode == 0
    return out


def ensure_ready(cfg: Optional[WhisperConfig] = None) -> dict:
    """Probe; install on demand if missing; re-probe. Returns the final probe."""
    cfg = cfg or resolve_config()
    pr = probe(cfg)
    if pr.get("critical_ok"):
        return pr
    log.info("vocal.whisper: installing faster-whisper into isolated venv (first run)")
    inst = install_dependencies(cfg)
    if not inst.get("ok"):
        pr["install"] = inst
        pr["error"] = inst.get("error") or (inst.get("stderr") or "")[:600]
        return pr
    pr2 = probe(cfg)
    pr2["install"] = {"ok": True, "mode": inst.get("install_mode")}
    return pr2


async def transcribe(
    audio_path: Path, language: str = "en", cfg: Optional[WhisperConfig] = None
) -> dict:
    """Run the isolated worker on one file. Returns the worker's JSON dict:
    {ok, language, text, segments} on success, {ok: False, error} otherwise.
    Never raises; install/spawn/parse failures all come back as ok=False."""
    cfg = cfg or resolve_config()
    ready = await asyncio.to_thread(ensure_ready, cfg)
    if not ready.get("critical_ok"):
        return {
            "ok": False,
            "error": ready.get("error") or "faster-whisper not installed",
            "probe": ready,
        }
    request = json.dumps(
        {
            "audio": str(audio_path),
            "language": language,
            "model": cfg.model,
            "device": cfg.device,
            "compute_type": cfg.compute_type,
        }
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            str(cfg.python_exe),
            str(_WORKER),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as e:
        return {"ok": False, "error": f"failed to spawn whisper worker: {e!r}"}
    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(request.encode("utf-8")),
            timeout=_TRANSCRIBE_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        proc.kill()
        return {
            "ok": False,
            "error": f"whisper worker timed out after {_TRANSCRIBE_TIMEOUT_SEC}s",
        }
    err_tail = stderr.decode("utf-8", "replace").strip()[-500:]
    if proc.returncode != 0 and not stdout.strip():
        return {"ok": False, "error": f"whisper worker failed: {err_tail}"}
    try:
        last = stdout.decode("utf-8", "replace").strip().splitlines()[-1]
        return json.loads(last)
    except (ValueError, IndexError) as e:
        return {"ok": False, "error": f"whisper worker bad output: {e}; {err_tail}"}


__all__ = [
    "WhisperConfig",
    "available",
    "ensure_ready",
    "install_dependencies",
    "probe",
    "resolve_config",
    "transcribe",
]
