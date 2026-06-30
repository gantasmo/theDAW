"""Vocal engine API.

The prerequisite pipeline that produces the canonical vocal artifact. Singing
synthesis and voice conversion (SoulX and others) stay deferred; they consume the
artifact this module produces.
"""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.core.jobs import Job, create_job, get_job

from . import service

router = APIRouter()


class PrepareRequest(BaseModel):
    asset_id: str
    isolate: bool = True
    isolation: str = "vocal_isolate"  # vocal_isolate | demucs
    cleanup: bool = True
    transcribe: bool = False
    language: str = "en"


class ReviewRequest(BaseModel):
    reviewed: bool = False
    notes: str = ""


@router.get("/health")
def health() -> dict:
    return service.health()


@router.post("/prepare")
async def prepare(req: PrepareRequest) -> dict:
    # Must be async: start_prepare schedules the pipeline with asyncio.create_task,
    # which needs a running loop (a sync route runs in a threadpool and would 500).
    job = create_job("vocal", f"Prepare vocal artifact ({req.asset_id})")
    service.start_prepare(job, req.model_dump())
    return {"ok": True, "job": {"id": job.id}}


def _job_payload(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "result": job.result,
        "error": job.error,
    }


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None or job.module != "vocal":
        raise HTTPException(status_code=404, detail="job not found")
    return _job_payload(job)


@router.post("/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None or job.module != "vocal":
        raise HTTPException(status_code=404, detail="job not found")
    job.update(status="cancelled", message="cancelled by user")
    return {"ok": True}


@router.get("/metadata/{asset_id}")
def get_metadata(asset_id: str) -> dict:
    art = service.load_artifact(asset_id)
    if art is None:
        raise HTTPException(status_code=404, detail="no artifact for asset")
    return art


@router.post("/audio-to-notes")
async def audio_to_notes(file: UploadFile = File(...)) -> dict:
    """Convert a recorded/uploaded audio clip to notes via basic-pitch (the same
    path as Analyze). Used by live mic recording in the MIDI tab."""
    notes = await service.audio_to_notes(file)
    return {"ok": True, "notes": [n.model_dump() for n in notes]}


@router.get("/midi/{asset_id}")
def export_midi(asset_id: str) -> FileResponse:
    """Download the artifact's notes as a Standard MIDI file (meta2midi)."""
    path = service.export_midi(asset_id)
    if path is None:
        raise HTTPException(status_code=404, detail="no notes to export")
    return FileResponse(str(path), media_type="audio/midi", filename="vocal_notes.mid")


@router.get("/validate/{asset_id}")
def validate(asset_id: str) -> dict:
    """notes -> MIDI -> notes round-trip drift, for the review surface."""
    return service.validate_roundtrip(asset_id)


@router.post("/review/{asset_id}")
def set_review(asset_id: str, req: ReviewRequest) -> dict:
    """Mark an artifact reviewed (the render-trust gate) and save reviewer notes."""
    result = service.set_review(asset_id, req.reviewed, req.notes)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("error", "no artifact"))
    return result


@router.get("/transcription/probe")
def transcription_probe() -> dict:
    """Sidecar status: is the isolated whisper venv built and importable?"""
    return service.transcription_probe()


@router.post("/transcription/install")
async def transcription_install() -> dict:
    """Provision the faster-whisper venv in the background (zero-terminal). Poll
    the returned job for progress. Async so start_install_transcription's
    asyncio.create_task has a running loop (a sync route would 500)."""
    job = create_job("vocal", "Install transcription (faster-whisper)")
    service.start_install_transcription(job)
    return {"ok": True, "job": {"id": job.id}}
