"""Adobe Audition .sesx session parser.

.sesx files are plain XML (uncompressed) with <sesx> root,
<session>, <tracks>, <audioTrack>, <fileList>, <markers>, <automation>.
Companion _SESF folder contains the actual media files.
"""

from __future__ import annotations
import logging
from pathlib import Path
from xml.etree import ElementTree as ET
from backend.modules.dawimport.models import DawProject, DawTrack, DawLocator

log = logging.getLogger(__name__)


def parse_sesx(path: str) -> DawProject:
    """Parse an Adobe Audition .sesx file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".sesx file not found: {path}")

    try:
        tree = ET.parse(str(file_path))
    except Exception as e:
        raise ValueError(f"Failed to parse .sesx XML: {e}")

    root = tree.getroot()
    daw = DawProject(source_daw="audition", name=file_path.stem)

    session = root.find("session")
    if session is None:
        session = root  # some versions omit wrapper

    # Tracks
    for track_elem in session.iter("audioTrack"):
        name = track_elem.get("name", "Track")
        daw.tracks.append(DawTrack(name=name, type="audio"))

    # Markers/locators
    for marker in session.iter("marker"):
        m_name = marker.get("name", "")
        try:
            pos = float(marker.get("time", "0"))
        except ValueError:
            pos = 0.0
        daw.locators.append(DawLocator(name=m_name, position=pos))

    return daw
