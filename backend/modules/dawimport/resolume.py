"""Resolume Arena .avc composition parser.

.avc files are JSON — entire composition with decks, clips, layers,
effects, audio/video sources, DMX mappings, and BPM.
"""

from __future__ import annotations
import json
import logging
from pathlib import Path
from backend.modules.dawimport.models import DawProject, DawTrack, DawClip

log = logging.getLogger(__name__)


def parse_avc(path: str) -> DawProject:
    """Parse a Resolume Arena .avc composition into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".avc file not found: {path}")
    try:
        with open(str(file_path), "r", encoding="utf-8") as f:
            comp = json.load(f)
    except Exception as e:
        raise ValueError(f"Failed to parse .avc JSON: {e}")

    daw = DawProject(source_daw="resolume", name=file_path.stem)

    # BPM
    if "bpm" in comp:
        try:
            daw.tempo = float(comp["bpm"])
        except (TypeError, ValueError):
            pass

    # Layers → tracks (Resolume uses layers, each with clips)
    for layer in comp.get("layers", []):
        layer_name = layer.get("name", "Layer")
        clips = []
        for clip in layer.get("clips", []):
            clip_name = clip.get("name", "Clip")
            # Audio file reference
            file_ref = None
            if "params" in clip:
                for p in clip["params"]:
                    if p.get("type") == "file" and p.get("value"):
                        file_ref = p["value"]
                        break
            clips.append(
                DawClip(
                    name=clip_name, start_time=0.0, end_time=0.0, file_path=file_ref
                )
            )
        daw.tracks.append(DawTrack(name=layer_name, type="audio", clips=clips))

    return daw
