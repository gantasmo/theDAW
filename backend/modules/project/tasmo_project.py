"""TasmoProject Pydantic model — the full project state for .tasmo files."""

from __future__ import annotations
from datetime import datetime, timezone
from pydantic import BaseModel, Field


class VstPluginState(BaseModel):
    plugin_path: str
    plugin_name: str
    parameters: dict[str, float] = {}
    preset_path: str | None = None
    instance_id: str = ""


class EffectChainNode(BaseModel):
    node_type: str  # "ffmpeg" | "vst3" | "builtin"
    effect_name: str
    parameters: dict[str, float] = {}
    bypass: bool = False
    vst_state: VstPluginState | None = None


class Locator(BaseModel):
    id: str
    name: str
    position: float
    color: str | None = None


class AutomationPoint(BaseModel):
    time: float
    value: float
    curve_type: str = "linear"


class AutomationLane(BaseModel):
    target: str
    points: list[AutomationPoint] = []


class Clip(BaseModel):
    id: str
    name: str
    clip_type: str  # "audio" | "midi" | "generated"
    track_id: str
    start_time: float = 0.0
    end_time: float = 0.0
    loop_start: float | None = None
    loop_end: float | None = None
    audio_file: str | None = None
    audio_file_checksum: str | None = None
    sample_rate: int = 48000
    channels: int = 2
    midi_notes: list[dict] | None = None
    midi_file: str | None = None
    generation_prompt: str | None = None
    generation_seed: int | None = None
    generation_params: dict | None = None
    warp_markers: list[dict] | None = None
    effect_chain: list[EffectChainNode] = []


class Track(BaseModel):
    id: str
    name: str
    type: str  # "audio" | "midi" | "return" | "master" | "bus"
    color: str | None = None
    volume_db: float = 0.0
    pan: float = 0.0
    mute: bool = False
    solo: bool = False
    arm: bool = False
    order: int = 0
    clips: list[Clip] = []
    effect_chain: list[EffectChainNode] = []
    input_routing: str | None = None
    output_routing: str | None = None
    send_amounts: dict[str, float] = {}


class TasmoProject(BaseModel):
    """The complete .tasmo project model."""

    format_version: int = 1
    project_name: str = "Untitled"
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    modified_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    author: str = ""
    tempo: float = 120.0
    time_signature: list[int] = [4, 4]
    sample_rate: int = 48000
    tracks: list[Track] = []
    locators: list[Locator] = []
    automation: list[AutomationLane] = []
    generation_history: list[dict] = []
    source_daw: str | None = None
    source_daw_version: str | None = None
    import_warnings: list[str] = []
