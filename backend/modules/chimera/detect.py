"""BPM and beat detection.

Public API:
    detect_tempo_and_beats(path) -> DetectionResult

Uses aubio when it can open the file (fast, accurate on WAV), and falls back
to librosa's beat tracker otherwise. The aubio pip wheel on Windows only ships
the ``wavread`` backend, so it raises on MP3/M4A/etc. ("could not find RIFF
header"); librosa decodes those formats directly (via soundfile/audioread), so
the fallback is what makes BPM work for compressed library tracks. No ffmpeg
transcode step required.

Returns None for `bpm` when the file is too short or no tempo can be locked
(silence, very sparse onsets). The caller decides how to handle that: the
Chimera mashup treats a None-BPM clip as "do not stretch, include as-is."
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional, TypedDict, cast

log = logging.getLogger(__name__)


_WIN_S = 1024
_HOP_S = 512
_LIBROSA_HOP_S = 256
_MIN_DURATION_SEC = 1.5
_LIBROSA_SR = 22050  # beat tracking is accurate here and half the memory of 44.1k


class DetectionResult(TypedDict):
    bpm: Optional[float]
    beats: list[float]
    confidence: float
    samplerate: int
    duration_sec: float


def _empty_result(sr: int = 0, duration_sec: float = 0.0) -> DetectionResult:
    return {
        "bpm": None,
        "beats": [],
        "confidence": 0.0,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
    }


def detect_tempo_and_beats(path: str | Path) -> DetectionResult:
    """Detect tempo + beat times (seconds). aubio first, librosa fallback."""
    try:
        return _detect_aubio(path)
    except Exception as e:
        log.info(
            "chimera detect: aubio could not handle %s (%s) — falling back to librosa",
            Path(path).name,
            e,
        )
        try:
            return _detect_librosa(path)
        except Exception as e2:
            log.warning(
                "chimera detect: librosa fallback also failed for %s: %s",
                Path(path).name,
                e2,
            )
            return _empty_result()


def _detect_librosa(path: str | Path) -> DetectionResult:
    """Tempo + beats via librosa — decodes MP3/M4A/etc. that aubio can't open."""
    import librosa
    import numpy as np
    import soundfile as sf

    try:
        source_sr = int(sf.info(str(path)).samplerate)
    except Exception:
        source_sr = 0
    y, sr = librosa.load(str(path), sr=_LIBROSA_SR, mono=True)
    sr = int(sr)
    if source_sr <= 0:
        source_sr = sr
    duration_sec = (len(y) / float(sr)) if sr else 0.0
    if y.size == 0 or duration_sec < _MIN_DURATION_SEC:
        return _empty_result(source_sr, duration_sec)

    tempo, beat_frames = librosa.beat.beat_track(
        y=y,
        sr=sr,
        hop_length=_LIBROSA_HOP_S,
    )
    beats = [
        float(t)
        for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=_LIBROSA_HOP_S)
    ]
    bpm_val = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0
    bpm: Optional[float] = bpm_val if bpm_val > 0 and beats else None

    # Confidence heuristic: how regular the inter-beat intervals are.
    confidence = 0.0
    if len(beats) > 2:
        intervals = np.diff(beats)
        mean_i = float(intervals.mean())
        if mean_i > 0:
            cv = float(intervals.std()) / mean_i
            confidence = max(0.0, min(1.0, 1.0 - cv))

    log.debug(
        "chimera detect (librosa): path=%s sr=%d dur=%.2f bpm=%s beats=%d conf=%.3f",
        Path(path).name,
        sr,
        duration_sec,
        bpm,
        len(beats),
        confidence,
    )
    return {
        "bpm": bpm,
        "beats": beats,
        "confidence": confidence,
        "samplerate": int(source_sr),
        "duration_sec": duration_sec,
    }


def _detect_aubio(path: str | Path) -> DetectionResult:
    import aubio

    # aubio is a C extension without type stubs — treat as Any so the analyzer
    # doesn't flag .source/.tempo (which it can't resolve).
    a = cast(Any, aubio)
    src = a.source(str(path), samplerate=0, hop_size=_HOP_S)
    sr = src.samplerate
    tempo_o = a.tempo("default", _WIN_S, _HOP_S, sr)

    beats: list[float] = []
    confidences: list[float] = []
    total_frames = 0

    while True:
        samples, read = src()
        is_beat = tempo_o(samples)
        total_frames += read
        if is_beat:
            beats.append(float(tempo_o.get_last_s()))
            confidences.append(float(tempo_o.get_confidence()))
        if read < _HOP_S:
            break

    try:
        src.close()
    except Exception:
        pass

    duration_sec = total_frames / float(sr) if sr > 0 else 0.0
    bpm_raw = float(tempo_o.get_bpm())

    bpm: Optional[float]
    if duration_sec < _MIN_DURATION_SEC or bpm_raw <= 0 or not beats:
        bpm = None
    else:
        bpm = bpm_raw

    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    log.debug(
        "chimera detect: path=%s sr=%d dur=%.2f bpm=%s beats=%d conf=%.3f",
        path,
        sr,
        duration_sec,
        bpm,
        len(beats),
        confidence,
    )

    return {
        "bpm": bpm,
        "beats": beats,
        "confidence": confidence,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
    }
