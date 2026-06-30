"""Ableton Live .als project parser.

.als files are gzip-compressed XML. This module decompresses and parses
the XML to extract tracks, clips, warp markers, tempo, locators, and
VST/AU plugin references with parameter snapshots.
"""

from __future__ import annotations

import gzip
import logging
import math
from pathlib import Path
from xml.etree import ElementTree as ET

from backend.modules.dawimport.models import (
    DawClip,
    DawDevice,
    DawLocator,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)


def parse_als(path: str) -> DawProject:
    """Parse an Ableton Live .als file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".als file not found: {path}")
    try:
        with gzip.open(str(file_path), "rb") as f:
            tree = ET.parse(f)
    except Exception as e:
        raise ValueError(f"Failed to decompress/parse .als file: {e}") from e

    root = tree.getroot()
    live_set = root.find("LiveSet")
    if live_set is None:
        live_set = root
        if root.tag != "LiveSet":
            raise ValueError("Cannot find <LiveSet> in .als XML")

    project = DawProject(source_daw="ableton", name=file_path.stem)
    project.scenes = _parse_scenes(live_set)

    # Tempo
    tempo_elem = live_set.find(".//MasterTrack/Mixer/Tempo/Manual")
    if tempo_elem is not None:
        try:
            project.tempo = float(tempo_elem.get("Value", "120"))
        except ValueError:
            pass

    # Tracks
    tracks_elem = live_set.find("Tracks")
    if tracks_elem is not None:
        _parse_tracks(tracks_elem, project, file_path)

    # Locators
    for loc_elem in live_set.iter("Locator"):
        name = loc_elem.get("Name", "")
        try:
            pos = float(loc_elem.get("Time", "0"))
        except ValueError:
            pos = 0.0
        project.locators.append(DawLocator(name=name, position=pos))

    return project


def _parse_scenes(live_set) -> list[str]:
    scenes: list[str] = []
    scenes_elem = live_set.find("Scenes")
    if scenes_elem is None:
        return scenes
    for index, scene_elem in enumerate(scenes_elem.findall("Scene")):
        name_elem = scene_elem.find("Name")
        name = name_elem.get("Value") if name_elem is not None else None
        scenes.append(name or f"Scene {index + 1}")
    return scenes


def _parse_tracks(tracks_elem, project: DawProject, als_path: Path) -> None:
    _tag_to_type = {
        "AudioTrack": "audio",
        "MidiTrack": "midi",
        "ReturnTrack": "return",
        "MasterTrack": "master",
    }
    track_index = 0
    for track_elem in tracks_elem:
        track_type = _tag_to_type.get(track_elem.tag)
        if track_type is None:
            continue
        project.tracks.append(_parse_track(track_elem, track_type, track_index, project.scenes, als_path))
        track_index += 1


def _parse_track(
    track_elem,
    track_type: str,
    track_index: int,
    scenes: list[str],
    als_path: Path,
) -> DawTrack:
    name_elem = track_elem.find(".//Name/EffectiveName")
    name = name_elem.get("Value", "Track") if name_elem is not None else "Track"

    # Ableton's Mixer/Volume/Manual is a linear amplitude gain (1.0 = unity =
    # 0 dB); DawTrack.volume_db is decibels, so convert.
    vol_linear = _read_float(track_elem.find(".//Mixer/Volume/Manual"), 1.0)
    vol_db = _linear_to_db(vol_linear)
    pan = _read_float(track_elem.find(".//Mixer/Pan/Manual"), 0.0)

    mute_elem = track_elem.find(".//Mixer/Mute")
    mute = mute_elem.get("Value", "0") == "1" if mute_elem is not None else False

    clips: list[DawClip] = []
    slots = track_elem.findall("./DeviceChain/MainSequencer/ClipSlotList/ClipSlot")
    for scene_index, slot in enumerate(slots):
        clip_elem = slot.find("./ClipSlot/Value/AudioClip")
        if clip_elem is None:
            clip_elem = slot.find("./ClipSlot/Value/MidiClip")
        if clip_elem is None:
            continue
        n = clip_elem.find("Name")
        cname = n.get("Value", "Clip") if n is not None else "Clip"
        file_path = None
        file_ref = clip_elem.find(".//SampleRef/FileRef")
        if file_ref is None:
            file_ref = clip_elem.find(".//SourceProxy/SampleRef/FileRef")
        if file_ref is not None:
            file_path = _read_file_ref(file_ref, als_path=als_path)
        clips.append(
            DawClip(
                name=cname,
                start_time=0.0,
                end_time=4.0,
                track_index=track_index,
                scene_index=scene_index,
                scene_name=scenes[scene_index] if scene_index < len(scenes) else None,
                slot_index=scene_index,
                file_path=file_path,
            )
        )

    devices: list[DawDevice] = []
    for dev in track_elem.iter("AudioEffectDevice"):
        dev_name = dev.get("ClassName", "Unknown")
        lib = dev.get("Library", "")
        if lib.endswith(".vst3"):
            dt = "vst3"
        elif lib.endswith(".component"):
            dt = "audiounit"
        else:
            dt = "builtin"
        devices.append(
            DawDevice(name=dev_name, plugin_type=dt, plugin_path=lib or None)
        )

    return DawTrack(
        name=name,
        type=track_type,
        volume_db=vol_db,
        pan=pan,
        mute=mute,
        solo=False,
        clips=clips,
        devices=devices,
    )


def _read_float(elem, default: float) -> float:
    """Read a numeric Ableton `Value` attribute, falling back to `default`."""
    if elem is None:
        return default
    try:
        return float(elem.get("Value", str(default)))
    except (TypeError, ValueError):
        return default


def _read_file_ref(file_ref, als_path: Path) -> str | None:
    """Resolve an Ableton FileRef path.

    Live sets commonly store project-local audio as ``RelativePath`` rather than
    ``AbsolutePath``. Prefer existing paths so collected project folders work
    without manual relinking.
    """
    candidates: list[Path] = []
    for tag in ("AbsolutePath", "RelativePath", "Path"):
        elem = file_ref.find(tag)
        value = elem.get("Value") if elem is not None else None
        if not value:
            continue
        p = Path(value).expanduser()
        if p.is_absolute():
            candidates.append(p)
        else:
            candidates.append(als_path.parent / p)
            candidates.append(als_path.parent.parent / p)

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    if candidates:
        return str(candidates[0])
    return None


def _linear_to_db(gain: float) -> float:
    """Convert a linear amplitude gain (1.0 = 0 dB) to decibels, floored at silence."""
    if gain <= 0.0:
        return -120.0
    return round(20.0 * math.log10(gain), 2)
