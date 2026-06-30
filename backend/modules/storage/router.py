"""FastAPI router for the storage module (prefix ``/api/storage``).

    GET    /locations            every model/data location with size + file count
    GET    /hf-cache             per-repo breakdown of the Hugging Face cache
    GET    /checkpoints          registered local checkpoints + catalog availability
    GET    /model-status         compact model/API readiness summary for Settings
    POST   /checkpoints          register a local checkpoint {path, name?}
    DELETE /checkpoints/{ck_id}  unregister (files are never touched)
    GET    /local-only           is no-download mode on?
    PUT    /local-only           toggle no-download mode {enabled}
    POST   /open                 open a known location in the OS file explorer
    POST   /pick-folder          open a native folder picker on the local machine
    POST   /pick-file            open a native file picker on the local machine

Sizes come from a recursive walk cached for 60 seconds per path (pass
``refresh=1`` to force). The WSL-side Magenta locations are probed through
``wsl.exe`` with a short timeout and the same cache, so a missing distro
degrades to ``exists: false`` instead of an error.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from stable_audio_3.model_configs import (
    _is_model_config_json,
    _local_override,
    _local_search_dirs,
    arc_models,
    resolve_local_checkpoint,
    rf_models,
)

from .store import PROJECT_ROOT, get_registry

log = logging.getLogger(__name__)

router = APIRouter()

_SIZE_TTL_SECONDS = 60.0
_size_cache: dict[str, tuple[float, dict]] = {}
_size_lock = threading.Lock()

_WSL_TIMEOUT = 10
_wsl_cache: dict[str, tuple[float, dict]] = {}
_PICKER_TIMEOUT_SECONDS = 300


def _dir_stats(path: Path) -> dict:
    """Recursive size + file count. Junctions/symlinks are not followed."""
    total = 0
    files = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return {"bytes": total, "files": files}


def _cached_dir_stats(path: Path, refresh: bool) -> dict:
    key = str(path).lower()
    now = time.monotonic()
    with _size_lock:
        hit = _size_cache.get(key)
        if hit and not refresh and now - hit[0] < _SIZE_TTL_SECONDS:
            return hit[1]
    stats = _dir_stats(path) if path.is_dir() else {"bytes": None, "files": None}
    with _size_lock:
        _size_cache[key] = (now, stats)
    return stats


def _hf_cache_dir() -> Path:
    from huggingface_hub.constants import HF_HUB_CACHE

    return Path(HF_HUB_CACHE)


def _wsl_distro() -> str | None:
    try:
        from backend.modules.magenta.sidecar import _wsl_distro as magenta_distro

        return magenta_distro()
    except Exception:
        return None


def _wsl_location(label: str, key: str, wsl_path: str, refresh: bool) -> dict:
    """Best-effort size probe of a WSL-side directory via ``wsl.exe du``."""
    now = time.monotonic()
    hit = _wsl_cache.get(key)
    if hit and not refresh and now - hit[0] < _SIZE_TTL_SECONDS * 5:
        return hit[1]

    distro = _wsl_distro()
    entry = {
        "key": key,
        "label": label,
        "path": None,
        "kind": "wsl",
        "exists": False,
        "bytes": None,
        "files": None,
    }
    if distro:
        try:
            # The script goes in on stdin AS BYTES: wsl.exe re-joins argv after
            # `--` without preserving quoting (which empties quoted variable
            # assignments passed via `bash -lc '...'`), and text-mode stdin
            # would CRLF-translate the newlines into bash syntax errors.
            script = (
                f'p="{wsl_path}"\n'
                'if [ -d "$p" ]; then\n'
                "  echo EXISTS\n"
                '  du -sb "$p" 2>/dev/null | cut -f1\n'
                '  readlink -f "$p"\n'
                "fi\n"
            )
            result = subprocess.run(
                ["wsl.exe", "-d", distro, "--", "bash", "-l"],
                input=script.encode("utf-8"),
                capture_output=True,
                timeout=_WSL_TIMEOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            stdout = result.stdout.decode("utf-8", errors="replace")
            lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
            if lines and lines[0] == "EXISTS":
                entry["exists"] = True
                if len(lines) > 1 and lines[1].isdigit():
                    entry["bytes"] = int(lines[1])
                if len(lines) > 2:
                    entry["path"] = (
                        f"\\\\wsl.localhost\\{distro}{lines[2].replace('/', chr(92))}"
                    )
        except (OSError, subprocess.TimeoutExpired) as e:
            log.debug("storage: WSL probe for %s failed: %s", key, e)
    _wsl_cache[key] = (now, entry)
    return entry


def _windows_locations() -> list[tuple[str, str, Path]]:
    """(key, label, path) for every Windows-side location worth surfacing."""
    locations: list[tuple[str, str, Path]] = [
        (
            "hf-cache",
            "Hugging Face cache (SA3 checkpoints, T5Gemma, more)",
            _hf_cache_dir(),
        ),
    ]
    seen: set[str] = set()
    for i, d in enumerate(_local_search_dirs()):
        norm = str(d).lower().rstrip("\\/")
        if norm in seen:
            continue
        seen.add(norm)
        locations.append((f"sa3-local-{i}", "Local model folder (SA3 search path)", d))
    locations += [
        (
            "generations",
            "Generated audio library",
            PROJECT_ROOT / "data" / "generations",
        ),
        ("rag-index", "Assistant RAG index", PROJECT_ROOT / "backend" / "rag_index"),
        (
            "torch-cache",
            "Torch hub cache (Demucs, MIDI models)",
            Path(os.environ.get("TORCH_HOME", Path.home() / ".cache" / "torch")),
        ),
    ]
    return locations


_inventory_cache: dict[str, tuple[float, list[dict]]] = {}


def _hf_cache_inventory() -> list[dict]:
    try:
        from huggingface_hub import scan_cache_dir

        info = scan_cache_dir(_hf_cache_dir())
        return sorted(
            (
                {
                    "name": r.repo_id,
                    "path": str(r.repo_path),
                    "bytes": r.size_on_disk,
                }
                for r in info.repos
            ),
            key=lambda m: -(m["bytes"] or 0),
        )
    except Exception:
        return []


def _checkpoint_folder_inventory(path: Path) -> list[dict]:
    """Every .safetensors under a local model folder (one level of subfolders),
    with the recommended pick marked: medium over small, ARC over RF."""
    found: list[dict] = []
    try:
        roots = [path] + [d for d in path.iterdir() if d.is_dir()]
    except OSError:
        return []
    for root in roots[:64]:
        try:
            for f in root.glob("*.safetensors"):
                try:
                    found.append(
                        {
                            "name": f"{root.name}/{f.name}" if root != path else f.name,
                            "path": str(f),
                            "bytes": f.stat().st_size,
                        }
                    )
                except OSError:
                    continue
        except OSError:
            continue
    found.sort(key=lambda m: -(m["bytes"] or 0))

    def _rank(name: str) -> int:
        n = name.lower()
        score = 0
        if "medium" in n:
            score += 2
        elif "small" in n:
            score += 1
        if "-arc" in n or "arc." in n:
            score += 4  # ARC = post-trained 8-step, the right default
        return score

    if len(found) > 1:
        best = max(found, key=lambda m: _rank(m["name"]))
        if _rank(best["name"]) > 0:
            best["recommended"] = True
            best["note"] = (
                "recommended: ARC checkpoints are the 8-step defaults; medium over small when the GPU allows"
            )
    elif len(found) == 1:
        found[0]["recommended"] = True
    return found


def _torch_cache_inventory(path: Path) -> list[dict]:
    out: list[dict] = []
    for sub in ("hub/checkpoints", "checkpoints", "hub"):
        d = path / sub
        if not d.is_dir():
            continue
        try:
            for f in d.iterdir():
                if f.is_file() and f.suffix in {".th", ".pt", ".pth", ".ckpt", ".onnx"}:
                    try:
                        out.append(
                            {"name": f.name, "path": str(f), "bytes": f.stat().st_size}
                        )
                    except OSError:
                        continue
        except OSError:
            continue
    out.sort(key=lambda m: -(m["bytes"] or 0))
    return out


def _location_inventory(key: str, path: Path, refresh: bool) -> list[dict]:
    """Model-ish contents per location, cached alongside the size walk."""
    now = time.monotonic()
    hit = _inventory_cache.get(key)
    if hit and not refresh and now - hit[0] < _SIZE_TTL_SECONDS:
        return hit[1]
    if key == "hf-cache":
        models = _hf_cache_inventory()
    elif key.startswith("sa3-local"):
        models = _checkpoint_folder_inventory(path)
    elif key == "torch-cache":
        models = _torch_cache_inventory(path)
    else:
        models = []
    _inventory_cache[key] = (now, models)
    return models


@router.get("/locations")
def storage_locations(refresh: bool = False) -> dict:
    items = []
    for key, label, path in _windows_locations():
        stats = _cached_dir_stats(path, refresh)
        models = _location_inventory(key, path, refresh) if path.is_dir() else []
        items.append(
            {
                "key": key,
                "label": label,
                "path": str(path),
                "kind": "windows",
                "exists": path.is_dir(),
                "models": models,
                **stats,
            }
        )
    items.append(
        _wsl_location(
            "Magenta RT2 model assets (WSL)",
            "magenta-assets",
            "$HOME/Documents/Magenta/magenta-rt-v2",
            refresh,
        )
    )
    items.append(
        _wsl_location(
            "Magenta RT2 engine venv (WSL)", "magenta-venv", "$HOME/mrt2", refresh
        )
    )
    return {"locations": items}


@router.get("/resolution-log")
def storage_resolution_log(since: int = 0) -> dict:
    """Every recorded model/checkpoint resolution decision this session:
    exactly which file came from which local folder, the HF cache, or a
    download, including download-needed blocks in local-only mode."""
    from stable_audio_3.model_configs import resolution_events

    return {"events": resolution_events(since)}


@router.get("/hf-cache")
def storage_hf_cache() -> dict:
    cache_dir = _hf_cache_dir()
    if not cache_dir.is_dir():
        return {"path": str(cache_dir), "repos": [], "total_bytes": 0}
    try:
        from huggingface_hub import scan_cache_dir

        info = scan_cache_dir(cache_dir)
    except Exception as e:
        raise HTTPException(500, f"HF cache scan failed: {e}") from e
    repos = sorted(
        (
            {
                "repo_id": r.repo_id,
                "repo_type": r.repo_type,
                "bytes": r.size_on_disk,
                "files": r.nb_files,
                "path": str(r.repo_path),
                "last_accessed": r.last_accessed,
            }
            for r in info.repos
        ),
        key=lambda r: -(r["bytes"] or 0),
    )
    return {"path": str(cache_dir), "repos": repos, "total_bytes": info.size_on_disk}


def _catalog_availability() -> list[dict]:
    """Built-in Stable Audio catalog, stamped with local/cache/download source."""
    from huggingface_hub import try_to_load_from_cache

    catalog = []
    for name, cfg in {**arc_models, **rf_models}.items():
        local = (
            _local_override(cfg.repo_id, cfg.config_path) is not None
            and _local_override(cfg.repo_id, cfg.ckpt_path) is not None
        )
        cached = local or (
            isinstance(try_to_load_from_cache(cfg.repo_id, cfg.config_path), str)
            and isinstance(try_to_load_from_cache(cfg.repo_id, cfg.ckpt_path), str)
        )
        catalog.append(
            {
                "name": name,
                "repo_id": cfg.repo_id,
                "source": "local" if local else "cached" if cached else "download",
            }
        )
    return catalog


@router.get("/checkpoints")
def storage_checkpoints() -> dict:
    registry = get_registry()
    catalog = _catalog_availability()
    return {
        "registered": registry.list_checkpoints(),
        "catalog": catalog,
        "local_only": registry.local_only(),
    }


def _sa3_runtime_status() -> dict:
    """Best-effort view of currently active/loaded SA3 models without loading any."""
    server_module = sys.modules.get("backend.server")
    pipelines = (
        getattr(server_module, "_generation_pipelines", {}) if server_module else {}
    )
    loaded = sorted(pipelines) if isinstance(pipelines, dict) else []
    return {
        "active_model": getattr(server_module, "_active_model_name", None)
        if server_module
        else None,
        "loaded_models": loaded,
    }


def _recommend_stable_model(models: list[dict]) -> str | None:
    available = {
        str(m["id"]): m
        for m in models
        if m.get("source") in {"local", "cached", "registered"}
    }
    for preferred in ("medium", "small"):
        if preferred in available:
            return preferred
    for model_id, model in available.items():
        if model.get("source") == "registered":
            return model_id
    return next(iter(available), None)


def _stable_provider_status() -> dict:
    registry = get_registry()
    local_only = registry.local_only()
    catalog = _catalog_availability()
    registered = registry.list_checkpoints()
    runtime = _sa3_runtime_status()
    active_model = runtime.get("active_model")
    loaded_models = set(runtime.get("loaded_models") or [])

    models: list[dict] = []
    for model in catalog:
        model_id = str(model["name"])
        source = str(model["source"])
        models.append(
            {
                "id": model_id,
                "label": model_id.title(),
                "source": source,
                "repo_id": model.get("repo_id"),
                "active": model_id == active_model,
                "loaded": model_id in loaded_models,
                "reason": "download blocked by local-only"
                if source == "download" and local_only
                else None,
            }
        )
    for checkpoint in registered:
        resolves = bool(checkpoint.get("resolves"))
        model_id = str(checkpoint.get("id"))
        models.append(
            {
                "id": model_id,
                "label": checkpoint.get("name") or model_id,
                "source": "registered" if resolves else "missing",
                "path": checkpoint.get("path"),
                "active": model_id == active_model,
                "loaded": model_id in loaded_models,
                "reason": None
                if resolves
                else "missing config JSON or .safetensors file",
            }
        )

    recommended = _recommend_stable_model(models)
    for model in models:
        if model["id"] == recommended:
            model["recommended"] = True
            model["reason"] = model.get("reason") or "best local/cached option"

    usable = [m for m in models if m.get("source") in {"local", "cached", "registered"}]
    active = bool(active_model and any(m["id"] == active_model for m in usable))
    if active:
        state = "active"
        summary = f"{active_model} is loaded and ready."
    elif usable:
        state = "ready"
        summary = f"{len(usable)} local/cached Stable Audio option(s) available."
    elif local_only:
        state = "download_blocked"
        summary = (
            "No local/cached Stable Audio model found; local-only blocks downloads."
        )
    else:
        state = "needs_setup"
        summary = "No local/cached Stable Audio model yet; first use may download one."

    return {
        "id": "stable",
        "label": "Stable Audio 3",
        "state": state,
        "summary": summary,
        "active": active,
        "models": models,
        **runtime,
    }


async def _magenta_provider_status() -> dict:
    try:
        from backend.modules.magenta import sidecar

        health = await sidecar.health()
        setup = await asyncio.to_thread(sidecar.setup_state)
        available = bool(health.get("available"))
        ready = bool(setup.get("ready"))
        if available:
            state = "active"
            summary = f"Engine is running at {health.get('url')}."
        elif ready:
            state = "ready"
            summary = (
                "Installed; start the Magenta engine from the model picker when needed."
            )
        else:
            state = "needs_setup"
            summary = "Run Setup-MRT2.bat to install the WSL engine and checkpoints."
        return {
            "id": "magenta",
            "label": "Magenta RT2",
            "state": state,
            "summary": summary,
            "active": available,
            "location": health.get("url"),
            "models": [
                {
                    "id": "mrt2_small",
                    "label": "MRT2 Small",
                    "source": "local" if ready else "missing",
                    "recommended": available or ready,
                    "reason": "WSL setup ready" if ready else "setup required",
                }
            ],
            "details": {"health": health, "setup": setup},
        }
    except Exception as e:
        return _unavailable_provider("magenta", "Magenta RT2", str(e))


def _suno_provider_status() -> dict:
    try:
        from backend.modules.suno.router import _read_api_key

        key = _read_api_key()
        configured = bool(key)
        return {
            "id": "suno",
            "label": "Suno API",
            "state": "ready" if configured else "needs_key",
            "summary": "Cloud generation key is configured."
            if configured
            else "Paste a Suno API key to enable cloud generation.",
            "active": configured,
            "models": [
                {
                    "id": "suno-cloud",
                    "label": "Suno cloud generation",
                    "source": "api" if configured else "missing",
                    "recommended": configured,
                    "reason": (key[:12] + "...") if key else "API key required",
                }
            ],
        }
    except Exception as e:
        return _unavailable_provider("suno", "Suno API", str(e))


def _demucs_provider_status() -> dict:
    try:
        from backend.modules.stems.sidecar import probe

        status = probe()
        ok = bool(status.get("ok"))
        running = bool(status.get("running"))
        package_exists = bool(status.get("package_exists"))
        if running:
            state = "active"
            summary = "Stem separation sidecar is running."
        elif ok:
            state = "ready"
            summary = "Demucs sidecar dependencies are installed."
        elif package_exists:
            state = "needs_setup"
            summary = "Integration package found, but Demucs dependencies need setup."
        else:
            state = "unavailable"
            summary = "Demucs integration package was not found."
        return {
            "id": "demucs",
            "label": "Demucs / Stems",
            "state": state,
            "summary": summary,
            "active": running,
            "location": status.get("package_path"),
            "models": [
                {
                    "id": "demucs-sidecar",
                    "label": "Demucs sidecar",
                    "source": "local" if ok else "missing",
                    "path": status.get("package_path"),
                    "recommended": ok,
                    "reason": status.get("demucs_version")
                    or status.get("demucs_error"),
                }
            ],
            "details": status,
        }
    except Exception as e:
        return _unavailable_provider("demucs", "Demucs / Stems", str(e))


def _midi_provider_status() -> dict:
    try:
        from backend.modules.midi.engine import engine_capabilities

        caps = engine_capabilities()
        engines = [name for name, ok in caps.items() if ok]
        ready = bool(engines)
        return {
            "id": "midi",
            "label": "MIDI Engines",
            "state": "ready" if ready else "needs_setup",
            "summary": ", ".join(engines)
            if ready
            else "Install basic-pitch or piano-transcription-inference for MIDI conversion.",
            "active": ready,
            "models": [
                {
                    "id": name,
                    "label": name.replace("_", " ").title(),
                    "source": "local" if ok else "missing",
                    "recommended": name == "basic_pitch" and ok,
                }
                for name, ok in caps.items()
            ],
            "details": caps,
        }
    except Exception as e:
        return _unavailable_provider("midi", "MIDI Engines", str(e))


def _unavailable_provider(provider_id: str, label: str, error: str) -> dict:
    return {
        "id": provider_id,
        "label": label,
        "state": "unavailable",
        "summary": error,
        "active": False,
        "models": [],
    }


@router.get("/model-status")
async def storage_model_status() -> dict:
    providers = [
        _stable_provider_status(),
        await _magenta_provider_status(),
        _suno_provider_status(),
        _demucs_provider_status(),
        _midi_provider_status(),
    ]
    usable_generation = any(
        p["id"] in {"stable", "magenta", "suno"} and p["state"] in {"active", "ready"}
        for p in providers
    )
    return {
        "providers": providers,
        "usable_generation": usable_generation,
        "local_only": get_registry().local_only(),
    }


class AddCheckpointBody(BaseModel):
    path: str
    name: str | None = None


@router.post("/checkpoints")
def storage_add_checkpoint(body: AddCheckpointBody) -> dict:
    try:
        return get_registry().add_checkpoint(body.path, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def _recognize_catalog_ckpt(ckpt: Path) -> dict | None:
    """Match a .safetensors filename against the built-in catalog so the config
    JSON can be copied from a source of truth instead of guessed."""
    from huggingface_hub import try_to_load_from_cache

    name = ckpt.name.lower()
    for model_name, cfg in {**arc_models, **rf_models}.items():
        if name != Path(cfg.ckpt_path).name.lower():
            continue
        config_src = _local_override(cfg.repo_id, cfg.config_path)
        if config_src is None:
            cached = try_to_load_from_cache(cfg.repo_id, cfg.config_path)
            config_src = cached if isinstance(cached, str) else None
        return {
            "model": model_name,
            "repo_id": cfg.repo_id,
            "config_name": cfg.config_path,
            "config_src": config_src,
            "config_available": config_src is not None,
        }
    return None


def _inspect_path(path_str: str) -> dict:
    """Everything the Add flow needs to know about a path BEFORE registering."""
    p = Path(path_str).expanduser()
    out: dict = {
        "path": str(p),
        "exists": p.exists(),
        "kind": "file" if p.is_file() else "folder" if p.is_dir() else "missing",
        "safetensors": [],
        "configs": [],
        "resolves": False,
        "problem": None,
        "recognized": None,
    }
    if not p.exists():
        out["problem"] = "That path does not exist."
        return out

    folder = p.parent if p.is_file() else p
    try:
        for f in sorted(folder.glob("*.safetensors")):
            out["safetensors"].append(
                {"name": f.name, "path": str(f), "bytes": f.stat().st_size}
            )
        for f in sorted(folder.glob("*.json")):
            out["configs"].append(
                {
                    "name": f.name,
                    "path": str(f),
                    "valid": _is_model_config_json(f),
                }
            )
    except OSError as e:
        out["problem"] = f"Could not read the folder: {e}"
        return out

    resolved = resolve_local_checkpoint(str(p), quiet=True)
    if resolved:
        out["resolves"] = True
        out["config_path"], out["ckpt_path"] = resolved
        out["recognized"] = _recognize_catalog_ckpt(Path(resolved[1]))
        return out

    sts = out["safetensors"]
    valid_configs = [c for c in out["configs"] if c["valid"]]
    if not sts:
        out["problem"] = "No .safetensors checkpoint found in that folder."
    elif p.is_dir() and len(sts) > 1 and not (folder / "model.safetensors").is_file():
        out["problem"] = (
            f"{len(sts)} checkpoints share that folder, so the pick is ambiguous. "
            "Browse to the exact .safetensors file instead."
        )
    elif not valid_configs:
        ckpt = Path(p if p.is_file() else sts[0]["path"])
        out["recognized"] = _recognize_catalog_ckpt(ckpt)
        if out["recognized"] and out["recognized"]["config_available"]:
            out["problem"] = (
                "No model config JSON sits next to the checkpoint, but this is a "
                f"known {out['recognized']['model']} checkpoint — Generate config "
                "copies the matching JSON in."
            )
        else:
            out["problem"] = (
                "No model config JSON found next to the checkpoint. Get it from "
                "the Hugging Face repo the checkpoint came from, or from the "
                "training/export run that produced it, and drop it in the same folder."
            )
    else:
        out["problem"] = "The checkpoint and config could not be paired."
    return out


@router.post("/checkpoints/inspect")
def storage_inspect_checkpoint(body: OpenBody) -> dict:
    return _inspect_path(body.path.strip())


@router.post("/checkpoints/generate-config")
def storage_generate_config(body: OpenBody) -> dict:
    """Copy the matching catalog config JSON next to a RECOGNIZED checkpoint.

    Configs are never synthesized: this only works when the .safetensors
    filename matches a built-in catalog checkpoint AND that catalog config is
    already on disk or in the HF cache (no download)."""
    import shutil

    info = _inspect_path(body.path.strip())
    if info["resolves"]:
        return {"created": None, "already_resolves": True}
    sts = info["safetensors"]
    p = Path(info["path"])
    if not sts:
        raise HTTPException(400, info["problem"] or "No checkpoint found there.")
    ckpt = p if p.is_file() else Path(sts[0]["path"])
    recognized = _recognize_catalog_ckpt(ckpt)
    if recognized is None:
        raise HTTPException(
            400,
            "This checkpoint is not a recognized built-in variant, so a config "
            "cannot be generated safely. Use the config JSON from wherever the "
            "checkpoint came from.",
        )
    if not recognized["config_available"]:
        raise HTTPException(
            409,
            f"Recognized as {recognized['model']}, but the matching config "
            f"({recognized['config_name']}) is not on disk or in the HF cache, "
            "and local-only rules forbid downloading it here.",
        )
    target = ckpt.with_suffix(".json")
    if target.exists():
        raise HTTPException(
            409, f"{target.name} already exists next to the checkpoint."
        )
    try:
        shutil.copyfile(recognized["config_src"], target)
    except OSError as e:
        raise HTTPException(500, f"Could not write {target}: {e}") from e
    log.info("storage: generated config %s from %s", target, recognized["config_src"])
    return {"created": str(target), "model": recognized["model"]}


@router.delete("/checkpoints/{ck_id:path}")
def storage_remove_checkpoint(ck_id: str) -> dict:
    if not get_registry().remove_checkpoint(ck_id):
        raise HTTPException(404, f"No registered checkpoint {ck_id!r}")
    return {"removed": ck_id}


class LocalOnlyBody(BaseModel):
    enabled: bool


@router.get("/local-only")
def storage_local_only() -> dict:
    return {"enabled": get_registry().local_only()}


@router.put("/local-only")
def storage_set_local_only(body: LocalOnlyBody) -> dict:
    return {"enabled": get_registry().set_local_only(body.enabled)}


class OpenBody(BaseModel):
    path: str


class PickerResult(BaseModel):
    path: str | None = None
    cancelled: bool = False


def _allowed_open_roots() -> list[str]:
    roots = [str(p) for _, _, p in _windows_locations()]
    roots += [e["path"] for e in get_registry().list_checkpoints()]
    distro = _wsl_distro()
    if distro:
        roots.append(f"\\\\wsl.localhost\\{distro}")
    return [r.lower().rstrip("\\/") for r in roots]


@router.post("/open")
def storage_open(body: OpenBody) -> dict:
    """Open a location in Explorer. Only paths under a known location are allowed."""
    target = body.path.strip()
    normalized = target.lower().rstrip("\\/")
    if not any(
        normalized == root
        or normalized.startswith(root + "\\")
        or normalized.startswith(root + "/")
        for root in _allowed_open_roots()
    ):
        raise HTTPException(403, "That path is not one of theDAW's model locations.")
    if sys.platform != "win32":
        raise HTTPException(501, "Open-in-explorer is implemented for Windows only.")
    try:
        os.startfile(target)  # noqa: S606 — deliberate, validated against known roots
    except OSError as e:
        raise HTTPException(404, f"Could not open {target!r}: {e}") from e
    return {"opened": target}


def _run_windows_picker(script: str) -> PickerResult:
    """Run a small STA PowerShell picker and return the selected local path.

    The frontend cannot read absolute folder paths from a normal browser file
    input. Because theDAW runs as a trusted local app, Settings asks the backend
    to show the native Windows dialog. Scripts are static constants so no user
    text is interpolated into PowerShell.
    """
    if sys.platform != "win32":
        raise HTTPException(501, "Native path picker is implemented for Windows only.")
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_PICKER_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise HTTPException(408, "Path picker timed out.") from e
    except OSError as e:
        raise HTTPException(500, f"Could not open path picker: {e}") from e

    if result.returncode == 3:
        return PickerResult(cancelled=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "path picker failed").strip()
        raise HTTPException(500, detail[:500])
    picked = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
    if not picked:
        return PickerResult(cancelled=True)
    return PickerResult(path=picked, cancelled=False)


@router.post("/pick-folder")
def storage_pick_folder() -> dict:
    script = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a folder for theDAW'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  exit 3
}
"""
    return _run_windows_picker(script).model_dump()


class PickFileRequest(BaseModel):
    # Optional OpenFileDialog filter, e.g.
    # "Audio (*.wav;*.flac)|*.wav;*.flac|All files (*.*)|*.*". Defaults to all
    # files so the dialog never hides project/audio files behind a model filter.
    filter: str | None = None
    title: str | None = None


def _ps_single_quote(value: str) -> str:
    """Escape a string for embedding inside a single-quoted PowerShell literal.

    Single-quoted PS strings treat ``$`` and backticks literally, so doubling
    the single quote is enough to prevent breakout; newlines are flattened.
    """
    return value.replace("\r", " ").replace("\n", " ").replace("'", "''")


@router.post("/pick-file")
def storage_pick_file(req: PickFileRequest | None = None) -> dict:
    flt = (req.filter if req and req.filter else None) or "All files (*.*)|*.*"
    title = (req.title if req and req.title else None) or "Select a file for theDAW"
    script = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '__TITLE__'
$dialog.Filter = '__FILTER__'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
} else {
  exit 3
}
"""
    script = script.replace("__TITLE__", _ps_single_quote(title)).replace(
        "__FILTER__", _ps_single_quote(flt)
    )
    return _run_windows_picker(script).model_dump()
