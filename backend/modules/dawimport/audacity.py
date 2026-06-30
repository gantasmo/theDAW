"""Audacity .aup3 project parser via py-aup3.

Audacity 3+ projects are SQLite databases containing custom binary XML
for the project data and audio sample blocks. The py-aup3 library
handles the binary XML deserialization.
"""

from __future__ import annotations
import logging
from pathlib import Path
from backend.modules.dawimport.models import DawProject, DawTrack

log = logging.getLogger(__name__)


def parse_aup3(path: str) -> DawProject:
    """Parse an Audacity .aup3 file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".aup3 file not found: {path}")

    try:
        from aup3 import AUP3
    except ImportError:
        raise ImportError(
            "py-aup3 is required for Audacity .aup3 parsing. Install: pip install git+https://github.com/mildsunrise/py-aup3.git"
        )

    daw = DawProject(source_daw="audacity", name=file_path.stem)

    try:
        with AUP3(str(file_path)) as proj:
            project = proj.project
            # Tempo / time sig
            if hasattr(project, "attributes"):
                attrs = project.attributes
                if hasattr(attrs, "project_tempo"):
                    daw.tempo = float(attrs.project_tempo)
            # Tracks
            if hasattr(project, "tracks"):
                for track in project.tracks:
                    t_name = getattr(track, "name", "Track")
                    t_type = "audio"
                    if hasattr(track, "type"):
                        tt = str(track.type).lower()
                        if "note" in tt:
                            t_type = "midi"
                    daw.tracks.append(DawTrack(name=t_name, type=t_type))
    except Exception as e:
        daw.warnings.append(f"Error parsing .aup3: {e}")

    return daw
