from __future__ import annotations

import asyncio
import base64
import json
import logging
import statistics
import tempfile
from pathlib import Path
from typing import Any, Optional

import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .config import probe
from .detect import detect_tempo_and_beats
from .mix import mix_clips
from .stretch import normalize_to_target, stretch_audio
from .weave import (
    MAX_POLYPHONY,
    bar_duration_sec,
    compute_chunks_sequential,
    resolve_chunk_bars,
    resolve_total_bars,
    scale_beats,
    schedule_song_arc,
)

log = logging.getLogger(__name__)

router = APIRouter()

# Cap on how many ffmpeg / librosa workers run at once during a mashup. ffmpeg
# is itself multi-threaded, so a small cap parallelizes the per-clip decode /
# stretch / detect without thrashing the box.
_MASHUP_CONCURRENCY = 3


@router.get("/probe")
def chimera_probe():
    """Return toolchain availability so the frontend can show a status indicator."""
    return probe()


@router.post("/probe/refresh")
def chimera_probe_refresh():
    """Force a re-detection (useful after installing ffmpeg/aubio without a restart)."""
    return probe(force=True)


@router.post("/analyze")
async def chimera_analyze(file: UploadFile = File(...)) -> dict[str, Any]:
    """Analyze ONE uploaded clip: BPM + per-beat times + musical key.

    Powers the Chimera stack's analyze-on-add (BPM/key badges and the CRISPR
    DNA beat rungs) for clips that have no library entry. Reuses
    detect_tempo_and_beats (the single source of truth for BPM in this
    codebase) and the library analysis key detector.
    """
    with tempfile.TemporaryDirectory(prefix="chimera_an_") as tmpdir:
        tmp = Path(tmpdir)
        suffix = Path(file.filename or "").suffix or ".bin"
        raw_path = tmp / f"raw{suffix}"
        with open(raw_path, "wb") as f:
            while chunk := await file.read(1 << 20):
                f.write(chunk)

        # Normalize to wav when ffmpeg is around (lets aubio open it on
        # Windows); otherwise run the detector on the raw file and rely on
        # its librosa fallback for compressed formats.
        detect_path = raw_path
        if probe()["ffmpeg"]:
            norm_path = tmp / "norm.wav"
            try:
                normalize_to_target(
                    raw_path, norm_path, target_sr=44100, target_channels=2
                )
                detect_path = norm_path
            except RuntimeError:
                detect_path = raw_path

        try:
            det = detect_tempo_and_beats(detect_path)
        except Exception as e:
            raise HTTPException(400, f"could not analyze {file.filename!r}: {e}") from e

        key_info: dict[str, Any] = {"key": None, "scale": None, "confidence": None}
        try:
            from backend.modules.analysis.key import detect_key

            key_info = detect_key(detect_path)
        except Exception as e:
            log.warning("chimera analyze: key detection failed: %s", e)

        return {
            "bpm": det["bpm"],
            "beats": det["beats"],
            "duration_sec": det["duration_sec"],
            "confidence": det["confidence"],
            "samplerate": det["samplerate"],
            "key": key_info.get("key"),
            "scale": key_info.get("scale"),
            "key_confidence": key_info.get("confidence"),
        }


def _parse_target_bpm(raw: str) -> Optional[float]:
    if raw is None:
        return None
    s = raw.strip().lower()
    if s in ("", "auto"):
        return None
    try:
        v = float(s)
    except ValueError:
        raise HTTPException(400, f"target_bpm must be a number or 'auto', got {raw!r}")
    if v <= 0:
        return None
    return v


def _parse_known_analysis(raw: str, n: int) -> list[Optional[dict[str, Any]]]:
    """Client-supplied per-clip analysis (from analyze-on-add).

    A JSON array aligned with the uploaded files; entries are
    {bpm, beats[], duration_sec} or null. Valid entries let the mashup skip
    re-running detect_tempo_and_beats on that clip.
    """
    if not raw:
        return [None] * n
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"known_analysis must be JSON: {e}")
    if not isinstance(parsed, list) or len(parsed) != n:
        raise HTTPException(400, f"known_analysis must be a list of length {n}")
    out: list[Optional[dict[str, Any]]] = []
    for entry in parsed:
        if (
            isinstance(entry, dict)
            and isinstance(entry.get("bpm"), (int, float))
            and entry["bpm"] > 0
            and isinstance(entry.get("beats"), list)
            and entry["beats"]
        ):
            out.append(entry)
        else:
            out.append(None)
    return out


def _parse_weights(raw: str, n: int) -> list[float]:
    if not raw:
        return [1.0] * n
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"weights must be a JSON array, got {raw!r}: {e}")
    if not isinstance(parsed, list):
        raise HTTPException(
            400, f"weights must be a JSON array, got {type(parsed).__name__}"
        )
    if len(parsed) != n:
        raise HTTPException(400, f"weights length {len(parsed)} != file count {n}")
    return [float(w) for w in parsed]


def _resolve_target_bpm(
    user_target: Optional[float],
    base_index: Optional[int],
    detected: list[Optional[float]],
) -> tuple[float, str]:
    """Returns (target_bpm, source)."""
    if base_index is not None:
        if base_index < 0 or base_index >= len(detected):
            raise HTTPException(
                400, f"base_index {base_index} out of range [0, {len(detected)})"
            )
        b = detected[base_index]
        if b is None:
            raise HTTPException(
                400, f"base_index {base_index} clip has no detected BPM"
            )
        return float(b), "base_clip"
    if user_target is not None:
        return float(user_target), "user"
    valid = [b for b in detected if b is not None]
    if valid:
        return float(statistics.median(valid)), "median"
    return 120.0, "fallback"


@router.post("/mashup")
async def chimera_mashup(
    files: list[UploadFile] = File(...),
    target_bpm: str = Form("auto"),
    base_index: Optional[int] = Form(None),
    weights: str = Form(""),
    align_mode: str = Form("start"),
    out_sr: int = Form(44100),
    weave_bars: int = Form(0),
    weave_total_bars: int = Form(0),
    weave_max_polyphony: int = Form(0),
    known_analysis: str = Form(""),
) -> dict[str, Any]:
    tools = probe()
    if not tools["ffmpeg"]:
        raise HTTPException(
            503,
            detail={
                "error": "Chimera toolchain not available",
                "install_hint": tools["install_hint"],
                "toolchain": tools,
            },
        )

    if not files:
        raise HTTPException(400, "No files uploaded")
    if align_mode not in ("start", "downbeat", "weave"):
        raise HTTPException(400, f"unknown align_mode: {align_mode!r}")

    user_target = _parse_target_bpm(target_bpm)
    weight_list = _parse_weights(weights, len(files))
    known_list = _parse_known_analysis(known_analysis, len(files))

    warnings: list[str] = []

    with tempfile.TemporaryDirectory(prefix="chimera_") as tmpdir:
        tmp = Path(tmpdir)

        n_files = len(files)
        sem = asyncio.Semaphore(max(1, min(_MASHUP_CONCURRENCY, n_files)))

        # 1) Read each upload to disk (sequential async I/O — fast), then
        #    decode/normalize them CONCURRENTLY (each ffmpeg call runs in a
        #    worker thread so they no longer block the event loop one-by-one).
        raw_info: list[tuple[Path, str]] = []
        for i, upload in enumerate(files):
            suffix = Path(upload.filename or "").suffix or ".bin"
            raw_path = tmp / f"raw_{i}{suffix}"
            with open(raw_path, "wb") as f:
                while chunk := await upload.read(1 << 20):
                    f.write(chunk)
            raw_info.append((raw_path, upload.filename or f"clip {i}"))

        norm_paths: list[Path] = [tmp / f"norm_{i}.wav" for i in range(n_files)]

        async def _normalize(i: int) -> None:
            async with sem:
                try:
                    await asyncio.to_thread(
                        normalize_to_target,
                        raw_info[i][0],
                        norm_paths[i],
                        target_sr=out_sr,
                        target_channels=2,
                    )
                except RuntimeError as e:
                    raise HTTPException(
                        400, f"could not decode {raw_info[i][1]!r}: {e}"
                    ) from e

        await asyncio.gather(*(_normalize(i) for i in range(n_files)))

        # 2) Use client-supplied analysis (from analyze-on-add) when present and
        #    only run the detector on clips without it, CONCURRENTLY — duration
        #    always comes from the normalized file on disk, never the client.
        detections: list[dict[str, Any]] = [None] * n_files  # type: ignore[list-item]

        async def _detect(i: int) -> None:
            p = norm_paths[i]
            ka = known_list[i]
            if ka is not None:
                info = sf.info(str(p))
                detections[i] = {
                    "bpm": float(ka["bpm"]),
                    "beats": [float(b) for b in ka["beats"]],
                    "confidence": 1.0,
                    "samplerate": int(info.samplerate),
                    "duration_sec": float(info.frames) / float(info.samplerate),
                }
            else:
                async with sem:
                    detections[i] = await asyncio.to_thread(detect_tempo_and_beats, p)

        await asyncio.gather(*(_detect(i) for i in range(n_files)))
        detected_bpms: list[Optional[float]] = [d["bpm"] for d in detections]

        target_bpm_used, target_bpm_source = _resolve_target_bpm(
            user_target, base_index, detected_bpms
        )
        if target_bpm_source == "fallback":
            warnings.append("No clip had a detectable BPM; using 120 as fallback.")

        # 3) Time-stretch every clip to the target BPM, CONCURRENTLY.
        stretched_paths: list[Path] = [
            tmp / f"stretched_{i}.wav" for i in range(n_files)
        ]
        stretch_meta: list[dict[str, Any]] = [None] * n_files  # type: ignore[list-item]

        async def _stretch(i: int) -> None:
            det = detections[i]
            if det["bpm"] is None or det["bpm"] <= 0:
                ratio = 1.0
            else:
                ratio = target_bpm_used / det["bpm"]
            async with sem:
                try:
                    stretch_meta[i] = await asyncio.to_thread(
                        stretch_audio, norm_paths[i], stretched_paths[i], ratio
                    )
                except RuntimeError as e:
                    raise HTTPException(500, f"stretch failed for clip {i}: {e}") from e

        await asyncio.gather(*(_stretch(i) for i in range(n_files)))

        for i, result in enumerate(stretch_meta):
            if result["engine"] == "atempo" and tools["librubberband"]:
                warnings.append(
                    f"Clip {i}: rubberband unavailable at stretch time; used atempo."
                )
            elif result["engine"] == "atempo" and not tools["librubberband"]:
                if i == 0:
                    warnings.append(
                        "ffmpeg lacks librubberband; using atempo fallback for all clips."
                    )

        n_clips = len(stretched_paths)
        clip_windows: list[tuple[float, float] | None] = [None] * n_clips
        mix_offsets_sec: list[float] = [0.0] * n_clips
        loop_to_sec: list[float | None] = [None] * n_clips
        stretched_durations: list[float] = []
        for sp in stretched_paths:
            stretched_durations.append(float(sf.info(str(sp)).duration))

        # weave-only: per original clip, list of placement metadata for the response
        placements_per_clip: list[list[dict[str, Any]]] = [[] for _ in range(n_clips)]

        # Inputs that flow into mix_clips. For start/downbeat these are the
        # original per-clip lists. For weave we rebuild them with one entry
        # per scheduled placement (so the same source file may appear many
        # times with different windows + offsets).
        mix_paths: list[Path] = list(stretched_paths)
        mix_weights: list[float] = list(weight_list)
        mix_windows: list[tuple[float, float] | None] = clip_windows
        mix_offsets: list[float] = mix_offsets_sec
        mix_loops: list[float | None] = loop_to_sec

        if align_mode == "downbeat":
            for i, (det, sm) in enumerate(zip(detections, stretch_meta)):
                beats = det["beats"]
                if not beats:
                    continue
                ratio = sm["ratio_used"] if sm["ratio_used"] > 0 else 1.0
                first_beat_stretched = beats[0] / ratio
                clip_windows[i] = (first_beat_stretched, stretched_durations[i])

        elif align_mode == "weave":
            chunk_bars = resolve_chunk_bars(weave_bars)
            bar_sec = bar_duration_sec(target_bpm_used)
            chunk_sec = chunk_bars * bar_sec

            # Total length is the base clip's stretched duration when one is
            # selected (so the song arc maps onto the user's reference);
            # otherwise fall back to the user/auto weave_total_bars setting.
            if base_index is not None and 0 <= base_index < len(stretched_durations):
                total_sec_target = stretched_durations[base_index]
                total_bars = max(1, int(total_sec_target / bar_sec))
                length_source = f"base clip ({files[base_index].filename!r})"
            else:
                total_bars = resolve_total_bars(weave_total_bars)
                total_sec_target = total_bars * bar_sec
                length_source = (
                    "weave_total_bars" if weave_total_bars > 0 else "default"
                )

            # Per-clip chunk list IN SOURCE ORDER — every contiguous chunk
            # is emitted so the natural arc (intro/body/outro) is available
            # to the scheduler.
            clip_chunks_seq: list[list[dict[str, Any]]] = []
            for i, (det, sm) in enumerate(zip(detections, stretch_meta)):
                ratio = sm["ratio_used"] if sm["ratio_used"] > 0 else 1.0
                beats_stretched = scale_beats(det["beats"], ratio)
                seq = compute_chunks_sequential(
                    stretched_paths[i],
                    beats_stretched,
                    target_bpm_used,
                    chunk_bars,
                )
                clip_chunks_seq.append(list(seq))

            polyphony_cap = (
                weave_max_polyphony if weave_max_polyphony > 0 else MAX_POLYPHONY
            )
            polyphony_cap = max(1, min(8, int(polyphony_cap)))
            arc_schedule = schedule_song_arc(
                clip_chunks_seq,
                total_sec_target,
                chunk_sec,
                max_polyphony=polyphony_cap,
            )

            expanded_paths: list[Path] = []
            expanded_weights: list[float] = []
            expanded_windows: list[tuple[float, float] | None] = []
            expanded_offsets: list[float] = []
            expanded_loops: list[float | None] = []

            for clip_idx, placements in enumerate(arc_schedule):
                chunks = clip_chunks_seq[clip_idx]
                if not placements:
                    warnings.append(
                        f"Clip {clip_idx} ({files[clip_idx].filename!r}) got no "
                        "timeline slots; increase weave_total_bars or decrease weave_bars"
                    )
                    continue
                if not chunks:
                    continue
                for placement in placements:
                    chunk = chunks[placement["chunk_idx"]]
                    expanded_paths.append(stretched_paths[clip_idx])
                    expanded_weights.append(weight_list[clip_idx])
                    expanded_windows.append((chunk["start_sec"], chunk["end_sec"]))
                    expanded_offsets.append(placement["output_start_sec"])
                    chunk_dur_actual = chunk["end_sec"] - chunk["start_sec"]
                    expanded_loops.append(
                        chunk_sec if chunk_dur_actual < chunk_sec * 0.95 else None
                    )
                    placements_per_clip[clip_idx].append(
                        {
                            "output_start_sec": float(placement["output_start_sec"]),
                            "output_end_sec": float(
                                placement["output_start_sec"] + chunk_sec
                            ),
                            "window_start_sec": float(chunk["start_sec"]),
                            "window_end_sec": float(chunk["end_sec"]),
                            "chunk_idx": int(placement["chunk_idx"]),
                            "rms": float(chunk.get("rms", 0.0)),
                        }
                    )

            if expanded_paths:
                mix_paths = expanded_paths
                mix_weights = expanded_weights
                mix_windows = expanded_windows
                mix_offsets = expanded_offsets
                mix_loops = expanded_loops
                total_placements = len(expanded_paths)
                last_end = max(o + chunk_sec for o in expanded_offsets)
                warnings.append(
                    f"Phrase Weave (song arc): {chunk_bars} bars/chunk ({chunk_sec:.2f}s), "
                    f"{total_bars} bars total from {length_source} ({total_sec_target:.2f}s), "
                    f"{total_placements} placements across {n_clips} clips, "
                    f"polyphony cap {polyphony_cap}, "
                    f"final length {last_end:.2f}s"
                )
            else:
                warnings.append(
                    "Phrase Weave produced no placements; check that clips have "
                    "enough audio for the chunk size"
                )

        # Chunk-level micro-fades prevent clicks at placement boundaries;
        # master fade gives the mashup a smooth in/out instead of an abrupt
        # cold start and a sudden silence at the end.
        if align_mode == "weave":
            chunk_fade = 0.05
            master_fade_in = 1.5
            master_fade_out = 2.0
        else:
            chunk_fade = 0.0
            master_fade_in = 0.0
            master_fade_out = 0.0

        final = tmp / "final.wav"
        mix_result = mix_clips(
            mix_paths,
            mix_weights,
            final,
            out_sr=out_sr,
            clip_windows=mix_windows,
            mix_offsets_sec=mix_offsets,
            loop_to_sec=mix_loops,
            chunk_fade_sec=chunk_fade,
            master_fade_in_sec=master_fade_in,
            master_fade_out_sec=master_fade_out,
        )

        with open(final, "rb") as f:
            mix_bytes = f.read()
        mix_b64 = base64.b64encode(mix_bytes).decode("ascii")

        per_clip: list[dict[str, Any]] = []
        for i, (upload, det, sm, sp) in enumerate(
            zip(files, detections, stretch_meta, stretched_paths)
        ):
            info = sf.info(str(sp))
            note_bits: list[str] = []
            if sm["clamped"]:
                note_bits.append(f"ratio clamped to {sm['ratio_used']:.3f}")
            if sm["note"] and sm["note"] not in note_bits:
                note_bits.append(sm["note"])
            if det["bpm"] is None:
                note_bits.append("no beats detected; chunks picked by RMS")

            placements = placements_per_clip[i]
            if placements:
                window_start = placements[0]["window_start_sec"]
                window_end = placements[0]["window_end_sec"]
            else:
                window = clip_windows[i]
                window_start = window[0] if window is not None else 0.0
                window_end = window[1] if window is not None else float(info.duration)

            per_clip.append(
                {
                    "index": i,
                    "label": upload.filename or f"clip_{i}",
                    "detected_bpm": det["bpm"],
                    "beats": det["beats"],
                    "stretch_ratio": sm["ratio_used"],
                    "stretched_duration_sec": info.duration,
                    "window_start_sec": window_start,
                    "window_end_sec": window_end,
                    "weight_used": weight_list[i],
                    "placements": placements,
                    "note": "; ".join(note_bits) if note_bits else None,
                }
            )

        return {
            "mix_base64": mix_b64,
            "mime": "audio/wav",
            "sample_rate": out_sr,
            "duration_sec": mix_result["duration_sec"],
            "target_bpm_used": target_bpm_used,
            "target_bpm_source": target_bpm_source,
            "align_mode_used": align_mode,
            "per_clip": per_clip,
            "warnings": warnings,
        }
