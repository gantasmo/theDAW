"""Vocal isolation and cleanup, delegating to the existing restoration DSP.

Default isolation is the instant mid/side extraction in restoration. Demucs
(method="demucs") is a future quality upgrade; until it is wired it falls back to
mid/side here. Every step returns the input path unchanged on failure, so a
missing optional tool never breaks the prepare pipeline.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)


async def isolate(
    input_path: Path, output_path: Path, method: str = "vocal_isolate"
) -> Path:
    try:
        from backend.modules.restoration import dsp

        await dsp.vocal_isolate(input_path, output_path, {"output": "vocals"})
        return output_path if output_path.is_file() else input_path
    except Exception as e:
        log.info("vocal.isolation: isolate failed (%s): %s", method, e)
        return input_path


async def cleanup(input_path: Path, output_path: Path) -> Path:
    try:
        from backend.modules.restoration import dsp

        await dsp.breath_removal(input_path, output_path, {})
        return output_path if output_path.is_file() else input_path
    except Exception as e:
        log.info("vocal.isolation: cleanup failed: %s", e)
        return input_path
