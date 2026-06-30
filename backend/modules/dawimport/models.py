"""DAW-agnostic intermediate model for imported projects.

All three DAW parsers (Ableton, Reaper, Logic) produce this same structure,
which mapping.py then converts into a TasmoProject for use in theDAW.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class DawDevice:
    name: str
    plugin_type: str  # "vst3" | "audiounit" | "builtin"
    plugin_path: str | None = None
    parameters: dict[str, float] = field(default_factory=dict)


@dataclass
class DawClip:
    name: str
    start_time: float
    end_time: float
    loop_start: float | None = None
    loop_end: float | None = None
    file_path: str | None = None
    midi_notes: list[dict] | None = None
    warp_markers: list[dict] | None = None


@dataclass
class DawTrack:
    name: str
    type: str  # "audio" | "midi" | "return" | "master"
    volume_db: float = 0.0
    pan: float = 0.0
    mute: bool = False
    solo: bool = False
    color: str | None = None
    clips: list[DawClip] = field(default_factory=list)
    devices: list[DawDevice] = field(default_factory=list)


@dataclass
class DawLocator:
    name: str
    position: float
    color: str | None = None


@dataclass
class DawProject:
    """DAW-agnostic intermediate representation."""

    source_daw: str  # "ableton" | "reaper" | "logic"
    source_version: str = ""
    name: str = "Imported Project"
    tempo: float = 120.0
    time_signature: tuple[int, int] = (4, 4)
    sample_rate: int = 44100
    tracks: list[DawTrack] = field(default_factory=list)
    locators: list[DawLocator] = field(default_factory=list)
    plugins_used: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    missing_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        from dataclasses import asdict

        return asdict(self)
