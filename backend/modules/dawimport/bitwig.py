"""Bitwig Studio .bwproject parser.

.bwproject files are gzip-compressed XML — same pattern as Ableton .als.
Bitwig's XML schema is actually cleaner and more consistent than Ableton's.
"""

from __future__ import annotations
import gzip
import logging
from pathlib import Path
from xml.etree import ElementTree as ET
from backend.modules.dawimport.models import DawProject, DawTrack

log = logging.getLogger(__name__)


def parse_bwproject(path: str) -> DawProject:
    """Parse a Bitwig Studio .bwproject file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".bwproject file not found: {path}")
    try:
        with gzip.open(str(file_path), "rb") as f:
            tree = ET.parse(f)
    except Exception as e:
        raise ValueError(f"Failed to decompress/parse .bwproject: {e}")

    root = tree.getroot()
    daw = DawProject(source_daw="bitwig", name=file_path.stem)

    # Tempo
    tempo_elem = root.find(".//tempo")
    if tempo_elem is not None:
        try:
            daw.tempo = float(tempo_elem.get("value", "120"))
        except ValueError:
            pass

    # Tracks
    for track_elem in root.iter("track"):
        name = track_elem.get("name", "Track")
        t_type = "audio"  # Bitwig tracks are agnostic; default audio
        daw.tracks.append(DawTrack(name=name, type=t_type))

    return daw
