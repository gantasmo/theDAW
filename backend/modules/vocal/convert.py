"""Round-trip between the canonical VocalArtifact notes and Standard MIDI.

meta2midi (`notes_to_midi`) writes artifact Notes (project-relative ms) to a
type-0 SMF via mido; midi2meta (`midi_to_notes`) parses an SMF back to ms-timed
Notes honoring running tempo. The two are inverses up to MIDI tick quantization,
so notes -> .mid -> notes preserves pitch/velocity and ms timing within a tick.
Lyrics/phonemes are intentionally NOT serialized to MIDI (they live in the
artifact), matching the schema's lossless-round-trip contract.

mido is imported lazily inside each function, so importing this module stays
cheap and a missing mido degrades gracefully (notes_to_midi -> ok:False,
midi_to_notes -> []).
"""

from __future__ import annotations

import importlib.util
import logging
import tempfile
from pathlib import Path
from typing import Optional

from .schema import Note

log = logging.getLogger(__name__)

_DEFAULT_TPB = 480
_DEFAULT_TEMPO_BPM = 120.0


def _have_mido() -> bool:
    return importlib.util.find_spec("mido") is not None


def notes_to_midi(
    notes: list[Note],
    out_path: Path,
    tempo_bpm: Optional[float] = None,
    ticks_per_beat: int = _DEFAULT_TPB,
) -> dict:
    """meta2midi: write artifact Notes to a type-0 SMF. Returns {ok, path, count}
    or {ok: False, error}. Never raises."""
    if not _have_mido():
        return {"ok": False, "error": "mido not installed"}
    import mido

    bpm = tempo_bpm if (tempo_bpm and tempo_bpm > 0) else _DEFAULT_TEMPO_BPM
    tempo = mido.bpm2tempo(bpm)
    ms_per_tick = mido.tick2second(1, ticks_per_beat, tempo) * 1000.0
    if ms_per_tick <= 0:
        return {"ok": False, "error": "bad tempo/ppq"}

    def ms_to_ticks(ms: float) -> int:
        return max(0, int(round(ms / ms_per_tick)))

    # Absolute-tick events (note_on at start, note_off at end); sort so note_off
    # precedes note_on at equal ticks, then emit as delta times.
    events: list[tuple[int, int, int, int]] = []  # (tick, kind, pitch, velocity)
    for n in notes:
        start = ms_to_ticks(n.start_ms)
        end = max(start + 1, ms_to_ticks(n.end_ms))
        pitch = max(0, min(127, int(n.pitch)))
        vel = max(1, min(127, int(n.velocity)))
        events.append((start, 1, pitch, vel))  # note_on
        events.append((end, 0, pitch, 0))  # note_off
    events.sort(key=lambda e: (e[0], e[1]))

    try:
        mid = mido.MidiFile(ticks_per_beat=ticks_per_beat)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
        prev = 0
        for tick, kind, pitch, vel in events:
            delta = tick - prev
            prev = tick
            if kind == 1:
                track.append(
                    mido.Message("note_on", note=pitch, velocity=vel, time=delta)
                )
            else:
                track.append(
                    mido.Message("note_off", note=pitch, velocity=0, time=delta)
                )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        mid.save(str(out_path))
    except Exception as e:
        return {"ok": False, "error": repr(e)}
    return {"ok": True, "path": str(out_path), "count": len(notes)}


def midi_to_notes(mid_path: Path) -> list[Note]:
    """midi2meta: parse an SMF into project-relative-ms Notes, honoring running
    set_tempo. Returns [] if mido is missing or the file is unreadable."""
    if not _have_mido():
        return []
    import mido

    try:
        mid = mido.MidiFile(str(mid_path))
    except Exception:
        return []
    tpb = mid.ticks_per_beat or _DEFAULT_TPB
    notes: list[Note] = []
    for track in mid.tracks:
        cur_tempo = 500000  # 120 BPM until a set_tempo arrives
        elapsed_ms = 0.0
        active: dict[int, tuple[int, int]] = {}
        for msg in track:
            elapsed_ms += mido.tick2second(msg.time, tpb, cur_tempo) * 1000.0
            if msg.type == "set_tempo":
                cur_tempo = msg.tempo
            elif msg.type == "note_on" and msg.velocity > 0:
                active[msg.note] = (int(elapsed_ms), int(msg.velocity))
            elif msg.type == "note_off" or (
                msg.type == "note_on" and msg.velocity == 0
            ):
                started = active.pop(msg.note, None)
                if started is not None:
                    start_ms, vel = started
                    notes.append(
                        Note(
                            start_ms=start_ms,
                            end_ms=int(elapsed_ms),
                            pitch=int(msg.note),
                            velocity=vel,
                        )
                    )
    notes.sort(key=lambda n: n.start_ms)
    return notes


def roundtrip_check(notes: list[Note]) -> dict:
    """notes -> SMF -> notes; report drift. Backs the review validator. Returns
    {ok, count_in, count_out, count_match, max_drift_ms} or {ok: False, error}."""
    if not _have_mido():
        return {"ok": False, "error": "mido not installed"}
    with tempfile.TemporaryDirectory() as td:
        mid = Path(td) / "rt.mid"
        w = notes_to_midi(notes, mid)
        if not w.get("ok"):
            return {"ok": False, "error": w.get("error")}
        back = midi_to_notes(mid)
    count_match = len(back) == len(notes)
    max_drift_ms = 0
    if count_match:
        a = sorted(notes, key=lambda n: (n.start_ms, n.pitch))
        b = sorted(back, key=lambda n: (n.start_ms, n.pitch))
        for x, y in zip(a, b):
            max_drift_ms = max(
                max_drift_ms,
                abs(x.start_ms - y.start_ms),
                abs(x.end_ms - y.end_ms),
            )
    return {
        "ok": True,
        "count_in": len(notes),
        "count_out": len(back),
        "count_match": count_match,
        "max_drift_ms": max_drift_ms,
    }


__all__ = ["midi_to_notes", "notes_to_midi", "roundtrip_check"]
