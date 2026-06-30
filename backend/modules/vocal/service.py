"""Vocal engine orchestration.

Composes existing theDAW tools (restoration isolation and cleanup, the basic-pitch
midi engine) and the new analyzers (dense F0 curve, segment VAD) into the canonical
VocalArtifact. Heavy work runs inside a job; heavy libraries load lazily inside the
preprocess steps, so importing this module stays cheap at startup. Singing synthesis
stays out of scope.

Tempo context and Library persistence are wired below. The offline vocal_processing
FFmpeg chain shapes the OUTPUT vocal, so it belongs to the render path and stays with
deferred SOULX rather than the prerequisite artifact. Faster-whisper transcription is
Phase 2b.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any, Optional

from backend.core.jobs import Job

from .preprocess import f0_curve, isolation
from .preprocess import notes as notes_step
from .preprocess import segments as segments_step
from .schema import Lyrics, Phrase, Source, Timing, VocalArtifact, Word

log = logging.getLogger(__name__)

# In-process artifact store so /metadata works in-session. A later increment also
# persists each artifact to the Library as a first-class item.
_artifacts: dict[str, dict] = {}

# Keep references to in-flight prepare tasks so they are not garbage-collected.
_running: set[asyncio.Task] = set()


def health() -> dict[str, Any]:
    return {"ok": True, "module": "vocal", "transcription": transcription_available()}


def transcription_available() -> bool:
    """True once the isolated faster-whisper venv exists and imports. Probing is
    a cheap subprocess and never raises into the request path."""
    try:
        from .transcription import available

        return available()
    except Exception as e:
        log.info("vocal: transcription probe failed: %s", e)
        return False


def transcription_probe() -> dict:
    """Full sidecar status for the UI (venv built? deps importable? model?)."""
    try:
        from .transcription import probe

        return probe()
    except Exception as e:
        return {"ok": False, "error": repr(e)}


def load_artifact(asset_id: str) -> Optional[dict]:
    if asset_id in _artifacts:
        return _artifacts[asset_id]
    # Fall back to the persisted metadata file written next to the audio.
    try:
        import json

        audio = _resolve_path(asset_id)
        if audio:
            f = audio.parent / "vocal_metadata.json"
            if f.is_file():
                return json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:
        log.info("vocal: artifact load failed for %s: %s", asset_id, e)
    return None


def _artifact_obj(asset_id: str) -> Optional[VocalArtifact]:
    """Load the persisted artifact dict and parse it back into a VocalArtifact."""
    art_dict = load_artifact(asset_id)
    if art_dict is None:
        return None
    try:
        return VocalArtifact(**art_dict)
    except Exception as e:
        log.info("vocal: artifact parse failed for %s: %s", asset_id, e)
        return None


def export_midi(asset_id: str) -> Optional[Path]:
    """meta2midi: render the artifact's notes to a .mid beside the audio and
    return its path. None when there is no artifact / no notes / no mido."""
    art = _artifact_obj(asset_id)
    if art is None or not art.notes:
        return None
    src = _resolve_path(asset_id)
    if src is None:
        return None
    from .convert import notes_to_midi

    out = src.parent / "vocal_notes.mid"
    res = notes_to_midi(art.notes, out, tempo_bpm=art.timing.tempo_bpm)
    return out if res.get("ok") else None


def validate_roundtrip(asset_id: str) -> dict:
    """notes -> SMF -> notes drift report for the review surface."""
    art = _artifact_obj(asset_id)
    if art is None:
        return {"ok": False, "error": "no artifact for asset"}
    from .convert import roundtrip_check

    return roundtrip_check(art.notes)


def set_review(asset_id: str, reviewed: bool, notes_text: str) -> dict:
    """Update the artifact's review gate in place (rewrite vocal_metadata.json and
    the in-process cache) without adding another Library artifact row."""
    art = _artifact_obj(asset_id)
    if art is None:
        return {"ok": False, "error": "no artifact for asset"}
    art.review.reviewed = bool(reviewed)
    art.review.notes = str(notes_text or "")
    payload = art.model_dump()
    src = _resolve_path(asset_id)
    if src is not None:
        try:
            import json

            (src.parent / "vocal_metadata.json").write_text(
                json.dumps(payload, indent=2), encoding="utf-8"
            )
        except Exception as e:
            log.info("vocal: review persist failed for %s: %s", asset_id, e)
    _artifacts[asset_id] = payload
    return {"ok": True, "review": payload["review"]}


def _resolve_entry_id(asset_id: str) -> Optional[str]:
    """Map an asset reference to a real library entry id. Accepts either a true
    entry id OR a human track title — the MIDI/vocal panel often passes the
    visible title (e.g. "Et Tu Machina"), which is not a directory name, so a
    plain id lookup misses every track. Fall back to an exact, then
    case-insensitive, title match."""
    try:
        from backend.modules.library.router import get_store

        store = get_store()
        if store.get_audio_path(asset_id) is not None:
            return asset_id
        entries = list(store.list_entries())
        for rec in entries:
            if rec.title == asset_id:
                return rec.id
        low = asset_id.strip().lower()
        for rec in entries:
            if (rec.title or "").strip().lower() == low:
                return rec.id
    except Exception as e:
        log.info("vocal: entry id resolution failed for %s: %s", asset_id, e)
    return None


def _resolve_path(asset_id: str) -> Optional[Path]:
    """Resolve a Library asset id (or title) to its audio file."""
    try:
        from backend.modules.library.router import get_store

        rid = _resolve_entry_id(asset_id) or asset_id
        path = get_store().get_audio_path(rid)
        return Path(path) if path else None
    except Exception as e:
        log.info("vocal: asset path resolution failed for %s: %s", asset_id, e)
        return None


def _fill_source_info(art: VocalArtifact, path: Path) -> None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        art.source.sample_rate = int(info.samplerate)
        art.source.duration_ms = int(info.frames / max(1, info.samplerate) * 1000)
    except Exception as e:
        log.info("vocal: source info read failed for %s: %s", path.name, e)


def _persist(asset_id: str, src_path: Path, payload: dict) -> None:
    """Write the artifact next to the audio and register it as a first-class
    Library artifact (kind="vocal"), reusing the notation-artifact table."""
    try:
        import json
        import uuid

        from backend.modules.library.router import get_store

        out = src_path.parent / "vocal_metadata.json"
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        get_store().db.add_notation_artifact(
            artifact_id=str(uuid.uuid4()),
            entry_id=asset_id,
            kind="vocal",
            path=str(out),
            engine="vocal",
            metadata={"version": payload.get("version")},
        )
    except Exception as e:
        log.info("vocal: artifact persist failed for %s: %s", asset_id, e)


def _tempo_bpm(audio_path: Path) -> Optional[float]:
    """Estimate tempo from the full mix; vocals alone have weak beats."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        if y.size == 0:
            return None
        tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
        val = float(np.atleast_1d(tempo)[0])
        return round(val, 2) if val > 0 else None
    except Exception as e:
        log.info("vocal.context: tempo failed: %s", e)
        return None


def _context(audio_path: Path) -> Timing:
    """Musical context. Tempo from the full mix; key and bars join later from the
    library analysis row when present."""
    return Timing(tempo_bpm=_tempo_bpm(audio_path))


def _sec_ms(sec: float) -> int:
    return int(round(float(sec) * 1000.0))


def _lyrics_from_transcription(res: dict, language: str) -> Lyrics:
    """Map the worker's seconds-based {language, text, segments[...]} onto the
    artifact Lyrics in project-relative milliseconds. Segments become phrases;
    word timestamps become Words."""
    words: list[Word] = []
    phrases: list[Phrase] = []
    for seg in res.get("segments", []):
        seg_text = (seg.get("text") or "").strip()
        s_start, s_end = seg.get("start"), seg.get("end")
        if seg_text and s_start is not None and s_end is not None:
            phrases.append(
                Phrase(text=seg_text, start_ms=_sec_ms(s_start), end_ms=_sec_ms(s_end))
            )
        for w in seg.get("words", []):
            wt = (w.get("word") or "").strip()
            ws, we = w.get("start"), w.get("end")
            if wt and ws is not None and we is not None:
                words.append(Word(text=wt, start_ms=_sec_ms(ws), end_ms=_sec_ms(we)))
    return Lyrics(
        language=res.get("language") or language,
        text=(res.get("text") or "").strip(),
        words=words,
        phrases=phrases,
        source="transcribed",
    )


async def audio_to_notes(upload: Any) -> list:
    """Recorded/uploaded audio -> notes via the SAME offline basic-pitch path as
    Analyze (much better than live YIN). Transcodes to wav first for decoder
    robustness, then reuses extract_notes. Returns list[Note]; [] on failure."""
    import tempfile

    suffix = Path(getattr(upload, "filename", "") or "rec.webm").suffix or ".webm"
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / f"rec{suffix}"
        try:
            raw.write_bytes(await upload.read())
        except Exception as e:
            log.info("vocal.audio_to_notes: read failed: %s", e)
            return []
        src = raw
        try:
            from backend.lib import ffmpeg

            wav = Path(td) / "rec.wav"
            await ffmpeg.render(raw, wav, [], ["-ac", "1", "-ar", "22050"])
            src = wav
        except Exception as e:
            log.info("vocal.audio_to_notes: transcode failed, using raw: %s", e)
        return notes_step.extract_notes(src)


async def _transcribe(path: Path, language: str, job: Optional[Job] = None) -> Lyrics:
    """Transcribe via the isolated faster-whisper sidecar and map to Lyrics.
    Never raises: returns empty Lyrics when transcription is unavailable, so a
    missing optional sidecar never fails the prepare pipeline."""
    from .transcription import transcribe as run_transcribe

    if job is not None:
        job.update(message="transcribing (first run installs whisper)")
    try:
        res = await run_transcribe(path, language)
    except Exception as e:
        log.info("vocal: transcription failed: %s", e)
        return Lyrics(language=language)
    if not res.get("ok"):
        log.info("vocal: transcription unavailable: %s", res.get("error"))
        return Lyrics(language=language)
    return _lyrics_from_transcription(res, language)


def start_prepare(job: Job, req: dict[str, Any]) -> None:
    """Spawn the prepare pipeline and track the task so it survives GC."""
    task = asyncio.create_task(run_prepare(job, req))
    _running.add(task)
    task.add_done_callback(_running.discard)


def start_install_transcription(job: Job) -> None:
    """Spawn the faster-whisper install as a tracked background job so the UI can
    pre-provision the sidecar (zero-terminal) and poll progress."""
    task = asyncio.create_task(_run_install_transcription(job))
    _running.add(task)
    task.add_done_callback(_running.discard)


async def _run_install_transcription(job: Job) -> None:
    try:
        job.update(status="running", progress=0.05, message="creating isolated venv")
        from .transcription import install_dependencies

        result = await asyncio.to_thread(install_dependencies)
        if result.get("ok"):
            job.result = {"ok": True, "mode": result.get("install_mode")}
            job.update(status="done", progress=1.0, message="faster-whisper installed")
        else:
            job.error = result.get("error") or (result.get("stderr") or "")[:600]
            job.update(status="failed", message="transcription install failed")
    except Exception as e:
        log.exception("vocal transcription install failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))


async def run_prepare(job: Job, req: dict[str, Any]) -> None:
    asset_id = str(req.get("asset_id", ""))
    try:
        job.update(status="running", progress=0.05, message="starting")
        src_path = _resolve_path(asset_id)
        if src_path is None or not src_path.is_file():
            raise FileNotFoundError(f"no audio for asset {asset_id}")

        art = VocalArtifact(source=Source(asset_id=asset_id))
        _fill_source_info(art, src_path)

        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            cur = src_path

            isolate = bool(req.get("isolate", True))
            method = str(req.get("isolation", "vocal_isolate"))
            if isolate:
                cur = await isolation.isolate(cur, work / "isolated.wav", method)
                art.source.isolation = method
            else:
                art.source.isolation = "none"
            job.update(progress=0.2, message="isolated")

            if bool(req.get("cleanup", True)):
                cur = await isolation.cleanup(cur, work / "cleaned.wav")
            job.update(progress=0.35, message="cleaned")

            art.f0 = f0_curve.compute_f0_curve(cur)
            job.update(progress=0.5, message="pitch")

            art.notes = notes_step.extract_notes(cur)
            job.update(progress=0.7, message="notes")

            art.segments = segments_step.detect_segments(cur)
            art.timing = _context(src_path)
            job.update(progress=0.85, message="segments")

            if bool(req.get("transcribe", False)):
                art.lyrics = await _transcribe(cur, str(req.get("language", "en")), job)
            job.update(progress=0.95, message="lyrics")

        payload = art.model_dump()
        _artifacts[asset_id] = payload
        _persist(asset_id, src_path, payload)
        job.result = payload
        job.update(status="done", progress=1.0, message="artifact ready")
    except Exception as e:
        log.exception("vocal prepare failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))
