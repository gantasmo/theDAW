"""FastAPI router for DAW project import (/api/dawimport/*).

All import endpoints take a server-side file path (theDAW operates on a local
file library) via a small JSON body, e.g. ``POST /api/dawimport/ableton`` with
``{"path": "/abs/path/Project.als"}``.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()


class PathRequest(BaseModel):
    path: str


class DetectResponse(BaseModel):
    daw: str  # "ableton" | "reaper" | "logic" | "unknown"
    name: str
    format: str  # "als" | "rpp" | "logicx"


@router.post("/detect", response_model=DetectResponse)
def detect_daw(req: PathRequest):
    """Detect DAW format from file extension / content."""
    p = Path(req.path)
    suffix = p.suffix.lower()
    if suffix == ".als":
        return DetectResponse(daw="ableton", name=p.stem, format="als")
    elif suffix in (".rpp", ".rpp-bak"):
        return DetectResponse(daw="reaper", name=p.stem, format="rpp")
    elif suffix == ".logicx":
        return DetectResponse(daw="logic", name=p.stem, format="logicx")
    elif suffix == ".flp":
        return DetectResponse(daw="fl_studio", name=p.stem, format="flp")
    elif suffix == ".aup3":
        return DetectResponse(daw="audacity", name=p.stem, format="aup3")
    elif suffix == ".sesx":
        return DetectResponse(daw="audition", name=p.stem, format="sesx")
    elif suffix == ".bwproject":
        return DetectResponse(daw="bitwig", name=p.stem, format="bwproject")
    elif suffix == ".avc":
        return DetectResponse(daw="resolume", name=p.stem, format="avc")
    elif suffix == ".cpr":
        return DetectResponse(daw="cubase", name=p.stem, format="cpr")
    elif suffix in (".ptx", ".pts"):
        return DetectResponse(daw="pro_tools", name=p.stem, format="ptx")
    else:
        return DetectResponse(daw="unknown", name=p.stem, format=suffix.lstrip("."))


@router.post("/ableton")
def import_ableton(req: PathRequest):
    """Parse an Ableton Live .als file and return a DawProject dict."""
    from backend.modules.dawimport.ableton import parse_als

    try:
        project = parse_als(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .als: {e}")
    return project.to_dict()


@router.post("/reaper")
def import_reaper(req: PathRequest):
    """Parse a Reaper .RPP file and return a DawProject dict."""
    from backend.modules.dawimport.reaper import parse_rpp

    try:
        project = parse_rpp(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .RPP: {e}")
    return project.to_dict()


@router.post("/logic")
def import_logic(req: PathRequest):
    """Read a Logic Pro X .logicx package and return metadata + audio refs."""
    from backend.modules.dawimport.logic import parse_logicx

    try:
        project = parse_logicx(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .logicx: {e}")
    return project.to_dict()


@router.get("/logic/export-hint")
def logic_export_hint():
    """Return instructions for Logic Pro users (export-all-tracks workflow)."""
    from backend.modules.dawimport.logic import export_hint

    return export_hint()


# --- Extended DAW imports (P0 + P1) ---


@router.post("/fl-studio")
def import_fl_studio(req: PathRequest):
    """Parse an FL Studio .flp file and return a DawProject dict."""
    from backend.modules.dawimport.fl_studio import parse_flp

    try:
        project = parse_flp(req.path)
    except (FileNotFoundError, ImportError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .flp: {e}")
    return project.to_dict()


@router.post("/audacity")
def import_audacity(req: PathRequest):
    """Parse an Audacity .aup3 file and return a DawProject dict."""
    from backend.modules.dawimport.audacity import parse_aup3

    try:
        project = parse_aup3(req.path)
    except (FileNotFoundError, ImportError) as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .aup3: {e}")
    return project.to_dict()


@router.post("/audition")
def import_audition(req: PathRequest):
    """Parse an Adobe Audition .sesx file and return a DawProject dict."""
    from backend.modules.dawimport.audition import parse_sesx

    try:
        project = parse_sesx(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .sesx: {e}")
    return project.to_dict()


@router.post("/bitwig")
def import_bitwig(req: PathRequest):
    """Parse a Bitwig Studio .bwproject file and return a DawProject dict."""
    from backend.modules.dawimport.bitwig import parse_bwproject

    try:
        project = parse_bwproject(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .bwproject: {e}")
    return project.to_dict()


@router.post("/resolume")
def import_resolume(req: PathRequest):
    """Parse a Resolume Arena .avc composition and return a DawProject dict."""
    from backend.modules.dawimport.resolume import parse_avc

    try:
        project = parse_avc(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse .avc: {e}")
    return project.to_dict()


@router.get("/cubase/export-hint")
def cubase_export_hint():
    """Instructions for Cubase users (no direct .cpr parse possible)."""
    return {
        "format": "cpr",
        "limitation": "Cubase .cpr is proprietary binary — no parser exists",
        "recommended_workflow": [
            "1. In Cubase, go to File -> Export -> Audio Mixdown (per track)",
            "2. Or: Select All Tracks -> Export Selected Tracks as Audio Files",
            "3. Import the resulting folder into theDAW via /api/dawimport/detect",
        ],
    }


@router.get("/pro-tools/export-hint")
def pro_tools_export_hint():
    """Instructions for Pro Tools users (no direct .ptx parse possible)."""
    return {
        "format": "ptx",
        "limitation": "Pro Tools .ptx is proprietary binary — no parser exists",
        "recommended_workflow": [
            "1. In Pro Tools, go to File -> Export -> All Tracks as Audio Files",
            "2. Choose WAV format and desired sample rate",
            "3. Import the resulting folder into theDAW via /api/dawimport/detect",
        ],
    }
