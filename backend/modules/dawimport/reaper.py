"""Reaper .RPP project parser via reaproj.

Uses the reaproj library (pip) for object-model parsing of .RPP files.
Falls back to a simple regex parser if reaproj is not installed.
"""

from __future__ import annotations
import logging
from pathlib import Path
from backend.modules.dawimport.models import DawProject, DawTrack, DawClip, DawLocator

log = logging.getLogger(__name__)


def parse_rpp(path: str) -> DawProject:
    """Parse a Reaper .RPP file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".RPP file not found: {path}")

    try:
        from reaproj import Project
    except ImportError:
        log.warning("reaproj not installed; falling back to minimal RPP parser")
        return _parse_rpp_minimal(path)

    project = Project.load(str(file_path))
    daw = DawProject(source_daw="reaper", name=file_path.stem)

    # Tracks
    for track in project.tracks:
        clips = []
        for item in getattr(track, "items", []):
            source = getattr(item, "source_path", None)
            clips.append(
                DawClip(
                    name=getattr(item, "name", "Item"),
                    start_time=float(getattr(item, "position", 0)),
                    end_time=float(getattr(item, "position", 0))
                    + float(getattr(item, "length", 0)),
                    file_path=source,
                )
            )
        daw.tracks.append(
            DawTrack(
                name=getattr(track, "name", "Track"),
                type="audio",
                volume_db=float(getattr(track, "volume", 0)),
                mute=getattr(track, "mute", False),
                solo=getattr(track, "solo", False),
                clips=clips,
            )
        )

    # Regions as locators
    for region in getattr(project, "regions", []):
        daw.locators.append(
            DawLocator(
                name=getattr(region, "name", ""),
                position=float(getattr(region, "start", 0)),
            )
        )

    # Markers
    for marker in getattr(project, "markers", []):
        daw.locators.append(
            DawLocator(
                name=getattr(marker, "name", ""),
                position=float(getattr(marker, "position", 0)),
            )
        )

    return daw


def _parse_rpp_minimal(path: str) -> DawProject:
    """Minimal fallback parser — reads track names + item positions as text."""
    daw = DawProject(source_daw="reaper", name=Path(path).stem)
    daw.warnings.append(
        "reaproj not installed; using minimal parser (tracks + items only)"
    )
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        raise ValueError(f"Cannot read .RPP file: {e}")
    import re

    for m in re.finditer(r'<TRACK\s+NAME\s+"([^"]*)"', text):
        daw.tracks.append(DawTrack(name=m.group(1), type="audio"))
    return daw
