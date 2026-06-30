"""Vocal-to-MIDI notes via the existing basic-pitch engine, parsed to artifact Notes.

Reuses backend/modules/midi convert_to_midi to write a MIDI file, then parses it
into project-relative-millisecond notes via the shared midi_to_notes converter (so
there is one SMF->Note implementation). Returns [] when basic-pitch is not
installed; it never triggers a surprise pip install (auto_install=False).
"""

from __future__ import annotations

import importlib.util
import logging
import tempfile
from pathlib import Path

from ..convert import midi_to_notes
from ..schema import Note

log = logging.getLogger(__name__)


def extract_notes(audio_path: Path) -> list[Note]:
    if importlib.util.find_spec("mido") is None:
        return []
    from backend.modules.midi.engine import convert_to_midi

    p = Path(audio_path)
    if not p.is_file():
        return []
    with tempfile.TemporaryDirectory() as td:
        mid_path = Path(td) / "notes.mid"
        res = convert_to_midi(p, mid_path, hint="auto", auto_install=False)
        if not res.get("ok") or not mid_path.is_file():
            log.info(
                "vocal.notes: basic-pitch unavailable/failed: %s", res.get("error")
            )
            return []
        return midi_to_notes(mid_path)
