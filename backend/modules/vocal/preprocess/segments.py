"""Voice-activity segmentation over librosa RMS.

A thin VAD: frames above an RMS floor are voiced; contiguous voiced runs become
phrase segments and gaps shorter than `max_merge_ms` are merged so a single
phrase is not split by tiny pauses. All timing is project-relative milliseconds.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..schema import Segment

log = logging.getLogger(__name__)

_SR = 22050
_HOP = 512


def detect_segments(
    audio_path: Path,
    max_merge_ms: float = 300.0,
    rms_floor_db: float = -45.0,
) -> list[Segment]:
    try:
        import librosa
        import numpy as np
    except ImportError:
        return []

    p = Path(audio_path)
    if not p.is_file():
        return []

    try:
        y, sr = librosa.load(str(p), sr=_SR, mono=True)
    except Exception as e:
        log.info("vocal.segments: load failed for %s: %s", p.name, e)
        return []
    if y.size == 0:
        return []

    rms = librosa.feature.rms(y=y, hop_length=_HOP)[0]
    if rms.size == 0:
        return []
    db = 20.0 * np.log10(np.maximum(rms, 1e-6))
    voiced = db > rms_floor_db
    hop_ms = _HOP / float(sr) * 1000.0

    # Contiguous voiced runs as [start_frame, end_frame).
    runs: list[list[int]] = []
    start: int | None = None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(voiced)])
    if not runs:
        return []

    # Merge runs separated by less than max_merge_ms.
    merged = [runs[0]]
    for s, e in runs[1:]:
        if (s - merged[-1][1]) * hop_ms <= max_merge_ms:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    return [
        Segment(id=idx, start_ms=int(s * hop_ms), end_ms=int(e * hop_ms), kind="phrase")
        for idx, (s, e) in enumerate(merged)
    ]
