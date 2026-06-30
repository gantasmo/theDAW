"""HTTP API for .gan web plugins.

Imports VST Foundry exports into .gan packages, lists the installed library,
and serves an extracted plugin's web assets to an iframe. The plugin UI talks
to theDAW over postMessage (relayed by the composed index.html); routing a
plugin's control outputs to targets happens on the frontend.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry

log = logging.getLogger(__name__)

router = APIRouter()

# Repo-root anchored, so it resolves regardless of the process CWD.
_REPO_ROOT = Path(__file__).resolve().parents[3]
GAN_DIR = _REPO_ROOT / "data" / "plugins"
RUNTIME_DIR = GAN_DIR / "_runtime"

# In-repo source for the bundled "The Owl" plugin (the sidecar .gan).
_OWL_PROJECT = (
    _REPO_ROOT
    / "backend"
    / "modules"
    / "plugin"
    / "assets"
    / "the-owl"
    / "project.json"
)
_OWL_BG = _REPO_ROOT / "frontend" / "public" / "owl" / "the-owl.png"


def _gan_path(plugin_id: str) -> Path:
    return GAN_DIR / f"{plugin_id}.gan"


def _runtime_dir(plugin_id: str) -> Path:
    return RUNTIME_DIR / plugin_id


def _entry_url(plugin_id: str, manifest: dict) -> str:
    entry = manifest.get("entry_html") or "index.html"
    return f"/api/plugin/{plugin_id}/runtime/{entry}"


def _ensure_runtime(plugin_id: str) -> dict:
    """Extract a stored .gan to its runtime dir if not already present; return
    the manifest."""
    gan = _gan_path(plugin_id)
    if not gan.is_file():
        raise HTTPException(404, f"Plugin not found: {plugin_id}")
    rt = _runtime_dir(plugin_id)
    if not (rt / "index.html").is_file():
        GanFile.extract(str(gan), str(rt))
    return GanFile.info(str(gan))


class ImportOwlRequest(BaseModel):
    project_path: str
    name: str | None = None


class OpenRequest(BaseModel):
    id: str | None = None
    path: str | None = None


@router.post("/import-owl")
def import_owl(req: ImportOwlRequest) -> dict:
    """Import a VST Foundry export (project.json or its folder) into a .gan,
    store it, extract its runtime, and return the manifest + entry URL."""
    src = Path(req.project_path)
    if src.is_dir():
        src = src / "project.json"
    if not src.is_file():
        raise HTTPException(400, f"project.json not found at: {req.project_path}")

    try:
        manifest, assets = import_vst_foundry(str(src), name=req.name)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Import failed: {e}")

    GAN_DIR.mkdir(parents=True, exist_ok=True)
    gan_path = _gan_path(manifest.id)
    manifest_dict = GanFile.save(manifest, assets, str(gan_path))
    GanFile.extract(str(gan_path), str(_runtime_dir(manifest.id)))

    return {
        "manifest": manifest_dict,
        "gan_path": str(gan_path),
        "entry_url": _entry_url(manifest.id, manifest_dict),
    }


@router.get("/list")
def list_plugins() -> dict:
    """List installed .gan plugins (manifest summary each)."""
    GAN_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for gan in sorted(GAN_DIR.glob("*.gan")):
        try:
            m = GanFile.info(str(gan))
        except (ValueError, OSError) as e:
            log.warning("Skipping unreadable .gan %s: %s", gan.name, e)
            continue
        out.append(
            {
                "id": m.get("id"),
                "name": m.get("name"),
                "kind": m.get("kind"),
                "description": m.get("description"),
                "controls": m.get("controls", []),
                "gan_path": str(gan),
                "entry_url": _entry_url(m.get("id", gan.stem), m),
            }
        )
    return {"plugins": out}


@router.get("/info")
def plugin_info(path: str) -> dict:
    """Read the manifest of a .gan at an arbitrary path (no install)."""
    try:
        return GanFile.info(path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/open")
def open_plugin(req: OpenRequest) -> dict:
    """Open an installed plugin by id, or install+open a .gan at a path.
    Returns the manifest + entry URL ready to iframe."""
    if req.id:
        manifest = _ensure_runtime(req.id)
        return {"manifest": manifest, "entry_url": _entry_url(req.id, manifest)}

    if req.path:
        src = Path(req.path)
        if not src.is_file():
            raise HTTPException(400, f".gan not found: {req.path}")
        try:
            manifest = GanFile.info(req.path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        pid = manifest.get("id") or src.stem
        # Install a copy into the library if it is not already there.
        GAN_DIR.mkdir(parents=True, exist_ok=True)
        dest = _gan_path(pid)
        if src.resolve() != dest.resolve():
            shutil.copyfile(src, dest)
        GanFile.extract(str(dest), str(_runtime_dir(pid)))
        return {"manifest": manifest, "entry_url": _entry_url(pid, manifest)}

    raise HTTPException(400, "Provide an id or a path.")


@router.post("/package-owl")
def package_owl() -> dict:
    """Build (or rebuild) the bundled 'The Owl' sidecar .gan in data/plugins from
    the in-repo assets (owl artwork + canvas surfaces), excluding the preset
    carousel. Returns its path so the UI can reveal/share it like a VST bundle."""
    if not _OWL_PROJECT.is_file():
        raise HTTPException(500, f"Owl project asset missing: {_OWL_PROJECT}")
    try:
        manifest, assets = import_vst_foundry(
            str(_OWL_PROJECT),
            name="The Owl",
            plugin_id="the-owl",
            background_path=str(_OWL_BG) if _OWL_BG.is_file() else None,
            exclude_substrings=["carousel"],
        )
    except (ValueError, KeyError) as e:
        raise HTTPException(500, f"Owl package failed: {e}")
    GAN_DIR.mkdir(parents=True, exist_ok=True)
    gan_path = _gan_path("the-owl")
    manifest_dict = GanFile.save(manifest, assets, str(gan_path))
    return {"manifest": manifest_dict, "gan_path": str(gan_path)}


class RevealRequest(BaseModel):
    path: str


@router.post("/reveal")
def reveal_path(req: RevealRequest) -> dict:
    """Reveal a file in the OS file manager (Explorer/Finder), selecting it."""
    p = Path(req.path)
    if not p.exists():
        raise HTTPException(404, f"Not found: {req.path}")
    plat: str = sys.platform
    try:
        if plat == "win32":
            subprocess.Popen(["explorer", f"/select,{p}"])
        elif plat == "darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent)])
    except OSError as e:
        raise HTTPException(500, f"Reveal failed: {e}")
    return {"status": "ok", "path": str(p)}


@router.delete("/{plugin_id}")
def delete_plugin(plugin_id: str) -> dict:
    """Remove an installed plugin and its extracted runtime."""
    gan = _gan_path(plugin_id)
    removed = False
    if gan.is_file():
        gan.unlink()
        removed = True
    rt = _runtime_dir(plugin_id)
    if rt.is_dir():
        shutil.rmtree(rt, ignore_errors=True)
    if not removed:
        raise HTTPException(404, f"Plugin not found: {plugin_id}")
    return {"status": "deleted", "id": plugin_id}


@router.get("/{plugin_id}/runtime/{asset_path:path}")
def serve_runtime(plugin_id: str, asset_path: str) -> FileResponse:
    """Serve an extracted plugin asset to the iframe. Guards against traversal."""
    _ensure_runtime(plugin_id)
    base = _runtime_dir(plugin_id).resolve()
    target = (base / asset_path).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(404, "Asset not found")
    return FileResponse(target)
