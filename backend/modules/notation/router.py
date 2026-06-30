"""FastAPI router for symbolic notation artifacts and conversions."""

from __future__ import annotations

import io
import mimetypes
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from backend.modules.library.router import get_store as get_library_store

from .arrangers.score_arrange import STYLES as ARRANGEMENT_STYLES
from .engine import (
    capabilities,
    convert_score,
    midi_to_arrangement,
    midi_to_musicxml,
    midi_to_tabs,
    register_existing_midis,
)

router = APIRouter()


# Output file extension for each supported export format.
_EXT_FOR_FORMAT = {
    "musicxml": ".musicxml",
    "abc": ".abc",
    "pdf": ".pdf",
    "svg": ".svg",
}


def _song_slug(title: str, fallback: str = "score") -> str:
    """Filesystem-safe, readable slug of a song title for score filenames."""
    cleaned = "".join(c if (c.isalnum() or c in " -_") else "_" for c in (title or ""))
    cleaned = "_".join(cleaned.split())  # collapse whitespace runs to one "_"
    cleaned = cleaned.strip("_-")
    return cleaned[:60] or fallback


def _entry_title(store: Any, entry_id: str) -> str:
    entry = store.get_entry(entry_id)
    return str(getattr(entry, "title", "") or "") if entry is not None else ""


def _scored_name(slug: str, base: str) -> str:
    """Prefix ``base`` with the song slug unless it already leads with it,
    so the file (and its download name) carries the originating song."""
    if slug and not base.lower().startswith(slug.lower()):
        return f"{slug}__{base}"
    return base


class ExportRequest(BaseModel):
    source_artifact_id: str
    format: str


class TabsRequest(BaseModel):
    source_artifact_id: Optional[str] = None
    midi_id: Optional[str] = None
    instrument: str = "guitar"
    tuning_name: Optional[str] = None
    tuning: Optional[list[int]] = None
    capo: int = 0
    difficulty: str = "medium"


class ArrangeRequest(BaseModel):
    style: str
    source_artifact_id: Optional[str] = None
    source_artifact_ids: Optional[list[str]] = None
    midi_id: Optional[str] = None


def _resolve_midi_artifact_path(store: Any, entry_id: str, artifact_id: str) -> Path:
    artifact = store.db.get_notation_artifact(artifact_id)
    if (
        artifact is None
        or artifact.get("entry_id") != entry_id
        or artifact.get("kind") != "midi"
    ):
        raise HTTPException(404, f"MIDI artifact {artifact_id!r} not found for entry")
    path = Path(artifact.get("path") or "")
    if not path.is_file():
        raise HTTPException(404, f"MIDI file missing on disk: {path}")
    return path


@router.get("")
@router.get("/")
def get_capabilities() -> dict[str, Any]:
    return capabilities()


@router.get("/{entry_id}/artifacts")
def list_artifacts(entry_id: str, kind: Optional[str] = None) -> dict[str, Any]:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    register_existing_midis(store.db, entry_id)
    artifacts = store.db.list_notation_artifacts(entry_id, kind=kind)
    return {"entry_id": entry_id, "artifacts": artifacts, "count": len(artifacts)}


@router.post("/{entry_id}/from-midi/{midi_id}")
def convert_midi_artifact(entry_id: str, midi_id: str) -> dict[str, Any]:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    title = str(getattr(entry, "title", "") or "")
    slug = _song_slug(title)
    midi_row = None
    for row in store.db.list_midis(entry_id):
        if row.get("id") == midi_id:
            midi_row = row
            break
    if midi_row is None:
        raise HTTPException(404, f"midi {midi_id!r} not found for entry {entry_id!r}")
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    output = entry_dir / "notation" / _scored_name(slug, f"{midi_id}.musicxml")
    result = midi_to_musicxml(
        store.db,
        entry_id=entry_id,
        midi_path=Path(midi_row.get("midi_path") or ""),
        output_path=output,
        source_ref=midi_id,
        artifact_id=f"{midi_id}__musicxml",
        title=title,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post("/{entry_id}/export")
def export_artifact(entry_id: str, body: ExportRequest) -> dict[str, Any]:
    """Export an existing notation artifact (MIDI or MusicXML) to another
    format and register the result. Targets: musicxml, abc, pdf, svg."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    fmt = body.format.lower().strip()
    ext = _EXT_FOR_FORMAT.get(fmt)
    if ext is None:
        raise HTTPException(422, f"unsupported export format: {body.format!r}")

    source = store.db.get_notation_artifact(body.source_artifact_id)
    if source is None or source.get("entry_id") != entry_id:
        raise HTTPException(
            404,
            f"artifact {body.source_artifact_id!r} not found for entry {entry_id!r}",
        )
    source_path = Path(source.get("path") or "")
    if not source_path.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {source_path}")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    title = _entry_title(store, entry_id)
    slug = _song_slug(title)
    output = entry_dir / "notation" / _scored_name(slug, f"{source_path.stem}{ext}")
    result = convert_score(
        store.db,
        entry_id=entry_id,
        source_path=source_path,
        fmt=fmt,
        output_path=output,
        source_ref=body.source_artifact_id,
        artifact_id=f"{body.source_artifact_id}__{fmt}",
        title=title,
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post("/{entry_id}/tabs")
def make_tabs(entry_id: str, body: TabsRequest) -> dict[str, Any]:
    """Arrange a MIDI artifact into guitar/bass tablature (alphaTex).

    The source MIDI is either a notation artifact (``source_artifact_id`` of
    kind ``midi``) or a legacy ``midi_id``."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    midi_path: Optional[Path] = None
    source_ref: Optional[str] = None
    stem: Optional[str] = None
    if body.source_artifact_id:
        artifact = store.db.get_notation_artifact(body.source_artifact_id)
        if (
            artifact is None
            or artifact.get("entry_id") != entry_id
            or artifact.get("kind") != "midi"
        ):
            raise HTTPException(
                404, f"MIDI artifact {body.source_artifact_id!r} not found for entry"
            )
        midi_path = Path(artifact.get("path") or "")
        source_ref = body.source_artifact_id
        stem = midi_path.stem
    elif body.midi_id:
        midi_row = None
        for row in store.db.list_midis(entry_id):
            if row.get("id") == body.midi_id:
                midi_row = row
                break
        if midi_row is None:
            raise HTTPException(404, f"midi {body.midi_id!r} not found for entry")
        midi_path = Path(midi_row.get("midi_path") or "")
        source_ref = body.midi_id
        stem = body.midi_id
    else:
        raise HTTPException(422, "source_artifact_id or midi_id is required")

    if midi_path is None or not midi_path.is_file():
        raise HTTPException(404, f"MIDI file missing on disk: {midi_path}")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    slug = _song_slug(str(getattr(entry, "title", "") or ""))
    output = (
        entry_dir
        / "notation"
        / _scored_name(slug, f"{stem}__{body.instrument}.alphatex")
    )
    result = midi_to_tabs(
        store.db,
        entry_id=entry_id,
        midi_path=midi_path,
        output_path=output,
        instrument=body.instrument,
        tuning=body.tuning,
        tuning_name=body.tuning_name,
        capo=body.capo,
        difficulty=body.difficulty,
        title=str(getattr(entry, "title", "") or ""),
        source_ref=source_ref,
        artifact_id=f"{source_ref}__{body.instrument}__alphatex",
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post("/{entry_id}/arrange")
def make_arrangement(entry_id: str, body: ArrangeRequest) -> dict[str, Any]:
    """Arrange MIDI artifact(s) into a MusicXML score.

    Styles: lead-sheet, piano-reduction, simplified, band-score. ``band-score``
    takes ``source_artifact_ids`` (one staff per stem MIDI); the others take a
    single ``source_artifact_id`` or legacy ``midi_id``."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    style = body.style.lower().strip()
    if style not in ARRANGEMENT_STYLES:
        raise HTTPException(422, f"unknown arrangement style: {body.style!r}")

    sources: list[Path] = []
    source_ref: Optional[str] = None
    if body.source_artifact_ids:
        for artifact_id in body.source_artifact_ids:
            sources.append(_resolve_midi_artifact_path(store, entry_id, artifact_id))
        source_ref = body.source_artifact_ids[0]
    elif body.source_artifact_id:
        sources.append(
            _resolve_midi_artifact_path(store, entry_id, body.source_artifact_id)
        )
        source_ref = body.source_artifact_id
    elif body.midi_id:
        midi_row = None
        for row in store.db.list_midis(entry_id):
            if row.get("id") == body.midi_id:
                midi_row = row
                break
        if midi_row is None:
            raise HTTPException(404, f"midi {body.midi_id!r} not found for entry")
        path = Path(midi_row.get("midi_path") or "")
        if not path.is_file():
            raise HTTPException(404, f"MIDI file missing on disk: {path}")
        sources.append(path)
        source_ref = body.midi_id
    else:
        raise HTTPException(422, "source_artifact_id(s) or midi_id is required")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - existing module convention
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")
    slug = _song_slug(str(getattr(entry, "title", "") or ""))
    output = (
        entry_dir
        / "notation"
        / _scored_name(slug, f"{sources[0].stem}__{style}.musicxml")
    )
    result = midi_to_arrangement(
        store.db,
        entry_id=entry_id,
        sources=sources,
        style=style,
        output_path=output,
        source_ref=source_ref,
        title=str(getattr(entry, "title", "") or ""),
        artifact_id=f"{source_ref}__{style}__musicxml",
    )
    if not result.get("ok"):
        raise HTTPException(501, result)
    return result


@router.post("/backfill")
def backfill() -> dict[str, Any]:
    """Ensure every entry with MIDI has a titled sheet, and fix the placeholder
    title on existing sheets. Enqueued on the idle-gated background queue so a
    large library never blocks; falls back to running inline if the queue is
    unavailable."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    from .backfill import backfill_scores

    try:
        from backend.core.background_workers import get_background_queue

        async def _run() -> None:
            import asyncio

            await asyncio.to_thread(backfill_scores, store)

        get_background_queue().enqueue("notation:backfill", _run)
        return {"queued": True}
    except Exception:
        # No queue available — run synchronously and return the tallies.
        return {"queued": False, **backfill_scores(store)}


@router.get("/pack/{artifact_id}")
def download_score_pack(artifact_id: str) -> Response:
    """Download a score as a zip of the source plus a PDF. The PDF is engraved
    by the MuseScore CLI when available; without it the zip still carries the
    MusicXML so the download never fails."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, f"artifact {artifact_id!r} not found")
    src = Path(artifact.get("path") or "")
    if not src.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {src}")

    entry_id = str(artifact.get("entry_id") or "")
    slug = _song_slug(_entry_title(store, entry_id)) or src.stem
    members: list[tuple[Path, str]] = [(src, f"{slug}{src.suffix}")]

    # Engrave a PDF from a MusicXML sheet when MuseScore is installed.
    if artifact.get("kind") == "musicxml":
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - module convention
        if entry_dir is not None:
            pdf_out = entry_dir / "notation" / f"{src.stem}.pdf"
            result = convert_score(
                store.db,
                entry_id=entry_id,
                source_path=src,
                fmt="pdf",
                output_path=pdf_out,
                source_ref=artifact_id,
                artifact_id=f"{artifact_id}__pdf",
                title=_entry_title(store, entry_id),
            )
            if result.get("ok"):
                pdf_path = Path(result.get("path") or pdf_out)
                if pdf_path.is_file():
                    members.append((pdf_path, f"{slug}.pdf"))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, arcname in members:
            if path.is_file():
                zf.write(path, arcname=arcname)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slug}_score.zip"'},
    )


@router.get("/file/{artifact_id}")
def get_artifact_file(artifact_id: str) -> FileResponse:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    artifact = store.db.get_notation_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(404, f"artifact {artifact_id!r} not found")
    path = Path(artifact.get("path") or "")
    if not path.is_file():
        raise HTTPException(404, f"artifact file missing on disk: {path}")
    mime, _ = mimetypes.guess_type(str(path))
    kind = artifact.get("kind")
    if kind == "musicxml":
        mime = "application/vnd.recordare.musicxml+xml"
    elif kind in ("abc", "alphatex"):
        mime = "text/plain; charset=utf-8"
    # Name the download after the originating song so saved sheets are
    # identifiable even for artifacts created before song-prefixed filenames.
    slug = _song_slug(_entry_title(store, str(artifact.get("entry_id") or "")))
    download_name = _scored_name(slug, path.name)
    return FileResponse(
        path=str(path),
        media_type=mime or "application/octet-stream",
        filename=download_name,
    )
