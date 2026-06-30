"""FastAPI router for VST3 plugin hosting (/api/vst/*)."""

from __future__ import annotations

import io
import json
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from backend.modules.vst.scanner import (
    Vst3PluginInfo,
    scan_vst3_directories,
    load_cached_scan,
    save_scan_cache,
)
from backend.modules.vst.host import (
    load_plugin,
    unload_plugin,
    get_instance,
    list_instances,
    process_chain,
    process_with_plugin,
    list_builtin_effects,
)

log = logging.getLogger(__name__)
router = APIRouter()


# --- Request / Response models ---
class LoadRequest(BaseModel):
    plugin_path: str
    instance_id: str | None = None


class SetParamRequest(BaseModel):
    name: str
    value: float


class ProcessRequest(BaseModel):
    instance_ids: list[str]  # Ordered chain of instance IDs
    audio_path: str  # Path to a WAV/FLAC/etc. on disk
    output_path: str | None = None  # Where to write; temp file if omitted


class ScanResponse(BaseModel):
    plugins: list[dict]


# --- Endpoints ---


@router.get("/scan", response_model=ScanResponse)
def scan_vst3(refresh: bool = False):
    """Scan standard VST3 directories. Uses cache unless refresh=true."""
    if not refresh:
        cached = load_cached_scan()
        if cached is not None:
            return ScanResponse(plugins=[_plugin_dict(p) for p in cached])
    plugins = scan_vst3_directories()
    save_scan_cache(plugins)
    return ScanResponse(plugins=[_plugin_dict(p) for p in plugins])


@router.get("/scan/{path:path}", response_model=ScanResponse)
def scan_vst3_custom(path: str):
    """Scan a custom directory for VST3 plugins (always live, never cached)."""
    plugins = scan_vst3_directories(extra_paths=[path])
    return ScanResponse(plugins=[_plugin_dict(p) for p in plugins])


@router.post("/load")
def load_vst(req: LoadRequest):
    """Load a VST3 plugin and return its parameter descriptors."""
    try:
        inst = load_plugin(req.plugin_path, req.instance_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load VST3: {e}")
    return {
        "instance_id": inst.instance_id,
        "plugin_name": inst.plugin_name,
        "plugin_path": inst.plugin_path,
        "parameters": inst.parameters,
    }


@router.get("/plugins")
def get_loaded_plugins():
    """List all currently loaded plugin instances."""
    return list_instances()


@router.post("/process")
def process_audio(req: ProcessRequest):
    """Run an audio file through an ordered chain of loaded VST instances.

    Reads the file at its native sample rate, processes it through the
    instances named in ``instance_ids`` (in order), and writes a WAV to
    ``output_path`` (or a temp file). Returns the output path.
    """
    import soundfile as sf

    src = Path(req.audio_path)
    if not src.is_file():
        raise HTTPException(
            status_code=404, detail=f"Audio file not found: {req.audio_path}"
        )
    try:
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        audio, sr = sf.read(str(src), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read audio: {e}")

    try:
        processed = process_chain(req.instance_ids, audio, sr)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    created_temp = False
    out_path = req.output_path
    if out_path:
        out = Path(out_path)
        if out.is_dir():
            raise HTTPException(
                status_code=400, detail=f"output_path is a directory: {out_path}"
            )
        if not out.parent.exists():
            raise HTTPException(
                status_code=400,
                detail=f"output_path parent directory does not exist: {out.parent}",
            )
        if not out.suffix:
            # soundfile infers the container format from the extension.
            out_path = str(out.with_suffix(".wav"))
    else:
        fd, out_path = tempfile.mkstemp(suffix="_vst.wav")
        os.close(fd)
        created_temp = True

    try:
        sf.write(out_path, processed, sr)
    except Exception as e:
        if created_temp:
            try:
                os.unlink(out_path)
            except OSError:
                pass
        raise HTTPException(status_code=500, detail=f"Could not write output: {e}")

    return {
        "output_path": out_path,
        "sample_rate": int(sr),
        "instance_ids": req.instance_ids,
        "frames": int(processed.shape[0]),
    }


@router.post("/process-file")
async def process_file(
    audio: UploadFile = File(...),
    plugin_path: str = Form(...),
    params: str = Form("{}"),
):
    """Process an UPLOADED audio file through one VST3 plugin; return WAV bytes.

    Stateless mirror of /api/studio/process so a VST3 can be one stage of the
    MIX effect chain: the frontend uploads the running audio plus the plugin
    path and receives processed WAV back. The plugin is loaded fresh and
    discarded (never added to the instance registry).
    """
    import soundfile as sf

    path = Path(plugin_path)
    if not path.exists():
        raise HTTPException(
            status_code=404, detail=f"VST3 plugin not found: {plugin_path}"
        )
    try:
        data = await audio.read()
        # soundfile returns (frames, channels) float32 — the layout pedalboard expects.
        signal, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Could not read uploaded audio: {e}"
        )

    try:
        param_map = json.loads(params) if params else {}
        if not isinstance(param_map, dict):
            param_map = {}
    except json.JSONDecodeError:
        param_map = {}

    try:
        processed = process_with_plugin(plugin_path, signal, sr, param_map)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VST processing failed: {e}")

    buf = io.BytesIO()
    sf.write(buf, processed, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@router.get("/param/{instance_id}")
def get_params(instance_id: str):
    """Read all current parameter values on a loaded plugin."""
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"instance_id": instance_id, "parameters": inst.parameters}


@router.put("/param/{instance_id}")
def set_param(instance_id: str, req: SetParamRequest):
    """Set a single parameter value on a loaded plugin."""
    try:
        inst = get_instance(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    inst.set_parameter(req.name, req.value)
    return {"instance_id": instance_id, "name": req.name, "value": req.value}


@router.delete("/unload/{instance_id}")
def unload_vst(instance_id: str):
    """Unload a plugin instance."""
    try:
        unload_plugin(instance_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=e.args[0])
    return {"status": "unloaded", "instance_id": instance_id}


@router.get("/builtin")
def builtin_effects():
    """List pedalboard's built-in effects (no VST3 required)."""
    return list_builtin_effects()


def _plugin_dict(p: Vst3PluginInfo) -> dict:
    from dataclasses import asdict

    return asdict(p)
