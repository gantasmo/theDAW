"""Pydantic schema for the .gan plugin manifest.

A .gan file is a portable web-plugin package (a "pseudo-VST"): a ZIP holding a
manifest, an ``index.html`` entry, and its assets. The manifest declares what the
plugin is, the parameters a host can drive, and the control outputs it emits
(via ``postMessage``). It is intentionally a flat declaration, unlike the deep
track/clip model of .tasmo.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class GanParam(BaseModel):
    """An input parameter a host can set on the plugin."""

    id: str
    name: str
    type: str = "float"  # float | int | enum | bool
    min: float = 0.0
    max: float = 1.0
    default: float = 0.0
    unit: str = ""


class GanControl(BaseModel):
    """A control OUTPUT the plugin emits to its host.

    ``id`` matches the identifier the plugin uses in its
    ``postMessage({type:'updateValue', id, ...})`` payloads so the host can route
    each output to a chosen target.
    """

    id: str
    name: str
    kind: str = "value"  # value | xy | xyz | trigger


class GanCanvas(BaseModel):
    width: float = 0.0
    height: float = 0.0


class GanIoSide(BaseModel):
    channels: int = 2
    enabled: bool = False


class GanAudioIo(BaseModel):
    input: GanIoSide = Field(default_factory=GanIoSide)
    output: GanIoSide = Field(default_factory=GanIoSide)


class GanManifest(BaseModel):
    format: str = "gan"
    format_version: int = 1
    thedaw_version: str = "0.1.0"
    id: str
    name: str = "Untitled Plugin"
    description: str = ""
    version: str = "1.0.0"
    # controller = emits control values only (no audio); effect/instrument would
    # process/produce audio (not yet supported by the web runtime).
    kind: str = "controller"
    entry_html: str = "index.html"
    icon: str | None = None
    author: str = "GANTASMO"
    company: str = "GANTASMO"
    created_at: str = ""
    modified_at: str = ""
    canvas: GanCanvas = Field(default_factory=GanCanvas)
    audio_io: GanAudioIo = Field(default_factory=GanAudioIo)
    params: list[GanParam] = []
    controls: list[GanControl] = []
    # Provenance, e.g. "vst-foundry" for an imported VST Foundry export.
    source: str | None = None
