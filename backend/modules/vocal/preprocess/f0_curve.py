"""Dense per-frame F0 curve over librosa.pyin.

Extends the scalar analysis/pitch.py (which returns only mean/median/std) to emit
the full f0 array plus the voiced/unvoiced mask the vocal artifact needs. pyin
reports NaN where it cannot track confidently; those map to 0.0 Hz, voiced=False.
Heavy imports are lazy so importing this module stays cheap at startup.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from ..schema import F0Curve

log = logging.getLogger(__name__)

# Monophonic vocal range: ~C2 to ~C6. hop = frame_length // 4 (librosa pyin default).
_FMIN = 65.0
_FMAX = 1047.0
_SR = 22050
_FRAME = 2048
_HOP = 512


def compute_f0_curve(audio_path: Path) -> Optional[F0Curve]:
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None

    p = Path(audio_path)
    if not p.is_file():
        return None

    try:
        y, sr = librosa.load(str(p), sr=_SR, mono=True)
    except Exception as e:
        log.info("vocal.f0: load failed for %s: %s", p.name, e)
        return None
    if y.size == 0:
        return None

    try:
        f0, voiced_flag, _voiced_prob = librosa.pyin(
            y, fmin=_FMIN, fmax=_FMAX, sr=sr, frame_length=_FRAME, hop_length=_HOP
        )
    except Exception as e:
        log.info("vocal.f0: pyin failed for %s: %s", p.name, e)
        return None
    if f0 is None or len(f0) == 0:
        return None

    hz = [0.0 if np.isnan(v) else float(v) for v in f0]
    if voiced_flag is not None:
        voiced = [bool(b) for b in voiced_flag]
    else:
        voiced = [v > 0.0 for v in hz]
    hop_ms = _HOP / float(sr) * 1000.0
    return F0Curve(hop_ms=hop_ms, hz=hz, voiced=voiced)
