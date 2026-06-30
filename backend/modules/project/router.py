"""FastAPI router for .tasmo project save/load (/api/project/*)."""

from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.modules.project.tasmo_project import TasmoProject
from backend.modules.project.tasmo_file import TasmoFile

log = logging.getLogger(__name__)
router = APIRouter()


# --- Recent files tracking (simple in-memory list) ---
_recent_files: list[dict] = []
MAX_RECENT = 20


class SaveRequest(BaseModel):
    project: dict  # TasmoProject as JSON dict
    path: str  # Where to save the .tasmo file
    embed_audio: bool = False  # If True, bundle audio; if False, link


class LoadRequest(BaseModel):
    path: str  # Path to the .tasmo file to open


class ExportAudioRequest(BaseModel):
    path: str  # Path to the .tasmo file
    output_dir: str  # Directory to extract embedded audio into


class LoadResponse(BaseModel):
    project: dict
    manifest: dict


@router.post("/save")
def save_project(req: SaveRequest):
    """Serialize current session → .tasmo file."""
    try:
        project = TasmoProject.model_validate(req.project)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid project data: {e}")

    # Auto-append .tasmo extension
    path = req.path
    if not path.endswith(".tasmo"):
        path += ".tasmo"

    try:
        manifest = TasmoFile.save(project, path, embed_audio=req.embed_audio)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save .tasmo: {e}")

    # Track in recent files
    _add_recent(path, project.project_name)
    return {"status": "saved", "path": path, "manifest": manifest}


@router.post("/load", response_model=LoadResponse)
def load_project(req: LoadRequest):
    """Deserialize .tasmo → restore session state."""
    try:
        project, manifest = TasmoFile.load(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load .tasmo: {e}")

    _add_recent(req.path, project.project_name)
    return LoadResponse(project=project.model_dump(), manifest=manifest)


@router.get("/info")
def project_info(path: str):
    """Read manifest from .tasmo without full project load."""
    try:
        return TasmoFile.info(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/recent")
def recent_projects():
    """List recently opened/saved projects."""
    return _recent_files


@router.post("/export/audio")
def export_audio(req: ExportAudioRequest):
    """Extract embedded audio files from .tasmo to disk."""
    try:
        extracted = TasmoFile.extract_audio(req.path, req.output_dir)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract audio: {e}")
    return {"extracted": extracted, "count": len(extracted)}


@router.get("/list-audio")
def list_audio(path: str):
    """List embedded audio file names inside a .tasmo."""
    try:
        return {"files": TasmoFile.list_audio(path)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _add_recent(path: str, name: str) -> None:
    """Add to recent files list (deduped, most recent first)."""
    global _recent_files
    entry = {"path": path, "name": name}
    _recent_files = [r for r in _recent_files if r["path"] != path]
    _recent_files.insert(0, entry)
    _recent_files = _recent_files[:MAX_RECENT]
