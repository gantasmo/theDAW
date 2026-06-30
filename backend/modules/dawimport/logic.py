"""Logic Pro X .logicx package reader.

.logicx is a macOS package (directory bundle). The core arrangement data
(ProjectData) is proprietary binary with no public spec, so we can only
extract:
  - DocumentInfo.plist → tempo, key signature metadata
  - Media/Audio Files/ → audio files
  - Freeze Files/ → pre-rendered track audio
  - Plug-In Settings/ directory names → plugin names used

For full arrangement import, users should Export All Tracks as Audio Files
from Logic Pro (File → Export), then import that folder into theDAW.
"""

from __future__ import annotations
import logging
import plistlib
from pathlib import Path
from backend.modules.dawimport.models import DawProject, DawTrack, DawClip

log = logging.getLogger(__name__)


def parse_logicx(path: str) -> DawProject:
    """Parse a Logic Pro X .logicx package (directory).

    Returns a DawProject with metadata + audio file references extracted.
    Track structure is NOT available (ProjectData is proprietary binary).
    """
    pkg_path = Path(path)
    if not pkg_path.is_dir():
        raise FileNotFoundError(f".logicx package not found: {path}")

    daw = DawProject(source_daw="logic", name=pkg_path.stem)
    daw.warnings.append(
        "Logic Pro X ProjectData is proprietary binary — only metadata + "
        "audio files can be extracted. For full arrangement, use Logic's "
        "'Export All Tracks as Audio Files' and import that folder instead."
    )

    contents = pkg_path / "Contents"

    # 1. DocumentInfo.plist → tempo, key signature
    doc_info = contents / "DocumentInfo.plist"
    if doc_info.is_file():
        try:
            with open(doc_info, "rb") as f:
                plist = plistlib.load(f)
            if "tempo" in plist:
                daw.tempo = float(plist["tempo"])
            if "timeSignatureNumerator" in plist:
                num = int(plist.get("timeSignatureNumerator", 4))
                den = int(plist.get("timeSignatureDenominator", 4))
                daw.time_signature = (num, den)
            daw.sample_rate = int(plist.get("sampleRate", 44100))
        except Exception as e:
            daw.warnings.append(f"Could not parse DocumentInfo.plist: {e}")

    # 2. Audio files from Media/
    media_dir = contents / "Media" / "Audio Files"
    if media_dir.is_dir():
        for audio_file in sorted(media_dir.rglob("*")):
            if audio_file.suffix.lower() in (".aiff", ".aif", ".wav", ".caf", ".mp3"):
                daw.tracks.append(
                    DawTrack(
                        name=audio_file.stem,
                        type="audio",
                        clips=[
                            DawClip(
                                name=audio_file.stem,
                                start_time=0.0,
                                end_time=0.0,
                                file_path=str(audio_file),
                            )
                        ],
                    )
                )

    # 3. Freeze files (pre-rendered audio per track)
    freeze_dir = contents / "Freeze Files"
    if freeze_dir.is_dir():
        for audio_file in sorted(freeze_dir.rglob("*")):
            if audio_file.suffix.lower() in (".aiff", ".aif", ".wav"):
                daw.tracks.append(
                    DawTrack(
                        name=f"[Freeze] {audio_file.stem}",
                        type="audio",
                        clips=[
                            DawClip(
                                name=audio_file.stem,
                                start_time=0.0,
                                end_time=0.0,
                                file_path=str(audio_file),
                            )
                        ],
                    )
                )

    # 4. Plugin names from Plug-In Settings/ directory names
    plugin_dir = contents / "Plug-In Settings"
    if plugin_dir.is_dir():
        for plugin_folder in plugin_dir.iterdir():
            if plugin_folder.is_dir():
                daw.plugins_used.append(plugin_folder.name)

    return daw


def export_hint() -> dict:
    """Return instructions for Logic users who want full arrangement import."""
    return {
        "format": "logicx",
        "limitation": "ProjectData is proprietary binary — only metadata + audio extracted",
        "recommended_workflow": [
            "1. In Logic Pro X, go to File → Export → All Tracks as Audio Files",
            "2. Choose a location and format (WAV recommended)",
            "3. Import the resulting folder into theDAW via /api/dawimport/detect",
            "4. This gives per-track audio + MIDI for full arrangement mapping",
        ],
    }
