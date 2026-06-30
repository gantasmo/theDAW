"""FL Studio .flp project parser via pyflp.

Uses the pyflp library (pip, demberto) to parse FL Studio project files in
Image-Line's NEM binary format. pyflp exposes a parsed object model through
``pyflp.parse(path)`` (the package has no path-taking ``Project`` constructor).
"""

from __future__ import annotations

import logging
from pathlib import Path

from backend.modules.dawimport.models import DawClip, DawDevice, DawProject, DawTrack

log = logging.getLogger(__name__)

# FL Studio channel pan is a linear bipolar int: 0..12800, center 6400.
_PAN_CENTER = 6400.0


def parse_flp(path: str) -> DawProject:
    """Parse an FL Studio .flp file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".flp file not found: {path}")

    try:
        import pyflp
        from pyflp.channel import Instrument, Sampler
    except ImportError as e:
        raise ImportError(
            "pyflp is required for FL Studio .flp parsing. Install: pip install pyflp"
        ) from e

    flp = pyflp.parse(str(file_path))
    daw = DawProject(source_daw="fl_studio", name=file_path.stem)

    title = getattr(flp, "title", "") or ""
    if title:
        daw.name = title

    tempo = getattr(flp, "tempo", None)
    if tempo is not None:
        try:
            daw.tempo = float(tempo)
        except (TypeError, ValueError):
            pass

    # Each FL channel maps to a DawTrack. Samplers carry an audio sample;
    # Instruments are synth/generators (treated as MIDI sources). Layer,
    # Automation and other rack channels are skipped.
    try:
        for ch in flp.channels:
            ch_name = (
                getattr(ch, "display_name", None)
                or getattr(ch, "name", None)
                or "Channel"
            )
            clips: list[DawClip] = []
            devices: list[DawDevice] = []

            if isinstance(ch, Sampler):
                ch_type = "audio"
                sample_path = getattr(ch, "sample_path", None)
                if sample_path:
                    clips.append(
                        DawClip(
                            name=ch_name,
                            start_time=0.0,
                            end_time=0.0,
                            file_path=str(sample_path),
                        )
                    )
            elif isinstance(ch, Instrument):
                ch_type = "midi"
                plugin = getattr(ch, "plugin", None)
                if plugin is not None:
                    devices.append(
                        DawDevice(
                            name=getattr(plugin, "name", None) or ch_name,
                            plugin_type="vst3",
                        )
                    )
            else:
                continue

            daw.tracks.append(
                DawTrack(
                    name=ch_name,
                    type=ch_type,
                    pan=_norm_pan(getattr(ch, "pan", None)),
                    mute=not bool(getattr(ch, "enabled", True)),
                    clips=clips,
                    devices=devices,
                )
            )
    except Exception as e:
        daw.warnings.append(f"Error extracting channels: {e}")

    return daw


def _norm_pan(value: object) -> float:
    """Normalise FL Studio's 0..12800 (center 6400) channel pan to -1..1."""
    if value is None:
        return 0.0
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return max(-1.0, min(1.0, (v - _PAN_CENTER) / _PAN_CENTER))
