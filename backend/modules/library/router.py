"""FastAPI router for the disk-backed library.

Endpoints (prefix from module.json → `/api/library`):

    GET    /entries            list entries (?kind=audio|video|image|media|all)
    GET    /entries/{id}       single entry record
    GET    /audio/{id}         stream the audio file
    GET    /media/{id}         stream a video/image entry (Range-capable)
    GET    /media/{id}/thumb   poster thumbnail for a media entry
    PATCH  /entries/{id}       update user-mutable fields
    DELETE /entries/{id}       remove the entry (audio + metadata)
    POST   /import             accept an audio upload, return new entry
    POST   /import-media       accept a video/image upload, return new entry

The audio stream uses FileResponse so range requests work (essential for
the player to scrub) and there's no in-memory copy of large files.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .bundle import build_bundle_bytes
from .store import LibraryStore, _read_metadata, default_library_root

log = logging.getLogger(__name__)


_store: Optional[LibraryStore] = None


def get_store() -> LibraryStore:
    global _store
    if _store is None:
        project_root = Path(__file__).resolve().parents[3]
        _store = LibraryStore(default_library_root(project_root))
    return _store


router = APIRouter()


def _attach_play_counts(store: LibraryStore, entries: list[dict[str, Any]]) -> None:
    """Merge the persistent play_count / last_played_at from the DB into entry
    dicts. The DB column is the source for these; entries with no DB row read 0.
    The frontend sorts on play_count, so it ships with every entry payload."""
    if store.db is None:
        for e in entries:
            e.setdefault("play_count", 0)
            e.setdefault("last_played_at", None)
        return
    rows = {row["id"]: row for row in store.db.list_entries()}
    for e in entries:
        row = rows.get(e["id"]) or {}
        e["play_count"] = int(row.get("play_count") or 0)
        e["last_played_at"] = row.get("last_played_at")


_KIND_FILTERS: dict[str, Optional[set[str]]] = {
    "audio": {"audio"},
    "video": {"video"},
    "image": {"image"},
    "media": {"video", "image"},
    "all": None,
}


@router.get("/entries")
def list_entries(kind: str = "audio") -> dict[str, Any]:
    # Default 'audio' preserves the historical behavior: the tracks/stems/
    # midi library never sees video/image entries. The VIDEO tab requests
    # ?kind=media (video + image); ?kind=all returns everything.
    if kind not in _KIND_FILTERS:
        raise HTTPException(
            400, f"kind must be one of {sorted(_KIND_FILTERS)}, got {kind!r}"
        )
    store = get_store()
    entries = [r.to_dict() for r in store.list_entries(kinds=_KIND_FILTERS[kind])]
    _attach_play_counts(store, entries)
    return {
        "entries": entries,
        "count": len(entries),
        "root": str(store.root),
        "kind": kind,
    }


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str) -> dict[str, Any]:
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    data = record.to_dict()
    _attach_play_counts(store, [data])
    return data


@router.get("/audio/{entry_id}")
async def stream_audio(entry_id: str) -> Response:
    # CHANGED: support CDN-backed entries — if no local file exists but
    # metadata has a cdn_audio_url, proxy the audio from Suno CDN on demand.
    store = get_store()
    audio_path = store.get_audio_path(entry_id)
    if audio_path is not None and audio_path.is_file():
        mime, _ = mimetypes.guess_type(str(audio_path))
        return FileResponse(
            path=str(audio_path),
            media_type=mime or "audio/wav",
            filename=audio_path.name,
        )
    # No local file — check for a CDN URL in metadata.
    # CHANGED: on first CDN fetch, persist the MP3 locally so subsequent
    # plays/sends are instant (no re-download). The entry becomes a
    # normal local file after this one-time lazy download.
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    if entry_dir is not None:
        meta = _read_metadata(entry_dir)
        cdn_url = (meta or {}).get("cdn_audio_url")
        if cdn_url:
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.get(cdn_url)
                    resp.raise_for_status()
                audio_bytes = resp.content
                # Cache to disk so future requests skip CDN.
                local_name = (meta or {}).get("audio_filename") or f"{entry_id}.mp3"
                local_path = entry_dir / local_name
                try:
                    local_path.write_bytes(audio_bytes)
                    log.info("library: cached CDN audio to %s", local_path)
                except OSError as write_err:
                    log.warning("library: failed to cache CDN audio: %s", write_err)
                return Response(
                    content=audio_bytes,
                    media_type="audio/mpeg",
                    headers={"X-Audio-Source": "cdn-proxy"},
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("library: CDN proxy failed for %s: %s", entry_id, exc)
    raise HTTPException(404, f"Audio for entry {entry_id!r} not found")


@router.get("/stems/{stem_id}/audio")
def stream_stem_audio(stem_id: str) -> FileResponse:
    """Serve the actual WAV bytes for one separated stem so the frontend
    can fetch it as a Blob and feed it into the editor / init / inpaint
    targets (the library audio endpoint only knows about parent tracks,
    not their stem children)."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    # Stem rows are keyed per-entry, but stem ids are globally unique
    # (`{entry_id}__{stem_name}`), so a linear scan is fine — small N
    # and avoids needing a new DB index.
    for entry in store.db.list_entries():
        for stem in store.db.list_stems(entry["id"]):
            if stem.get("id") == stem_id:
                path = Path(stem.get("audio_path") or "")
                if not path.is_file():
                    raise HTTPException(404, f"stem file missing on disk: {path}")
                mime, _ = mimetypes.guess_type(str(path))
                return FileResponse(
                    path=str(path),
                    media_type=mime or "audio/wav",
                    filename=path.name,
                )
    raise HTTPException(404, f"stem {stem_id!r} not found")


@router.patch("/stems/{stem_id}")
def update_stem(stem_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Mutate a stem row. Currently only ``favorite`` is user-mutable so
    stems behave like first-class library items."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if "favorite" in patch:
        ok = store.db.set_stem_favorite(stem_id, bool(patch["favorite"]))
        if not ok:
            raise HTTPException(404, f"stem {stem_id!r} not found")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    return dict(row)


@router.delete("/stems/{stem_id}")
def delete_stem(stem_id: str) -> dict[str, Any]:
    """Delete one separated stem (its WAV on disk + its DB row), leaving the
    parent track and sibling stems untouched."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    audio_path = Path(row.get("audio_path") or "")
    if audio_path.is_file():
        try:
            audio_path.unlink()
        except OSError as e:
            log.warning("library: failed to delete stem file %s: %s", audio_path, e)
    store.db.delete_stem(stem_id)
    return {"deleted": stem_id}


@router.get("/media/{entry_id}")
def stream_media(entry_id: str) -> FileResponse:
    """Stream a video/image library entry. FileResponse honors Range
    requests, which video scrubbing needs."""
    store = get_store()
    media_path = store.get_media_path(entry_id)
    if media_path is None or not media_path.is_file():
        raise HTTPException(404, f"Media for entry {entry_id!r} not found")
    mime, _ = mimetypes.guess_type(str(media_path))
    return FileResponse(
        path=str(media_path),
        media_type=mime or "application/octet-stream",
        filename=media_path.name,
    )


@router.get("/media/{entry_id}/thumb")
def stream_media_thumb(entry_id: str) -> FileResponse:
    """Serve the poster thumbnail for a media entry (JPEG)."""
    store = get_store()
    thumb_path = store.get_thumb_path(entry_id)
    if thumb_path is None or not thumb_path.is_file():
        raise HTTPException(404, f"Thumbnail for entry {entry_id!r} not found")
    return FileResponse(path=str(thumb_path), media_type="image/jpeg")


@router.post("/import-media")
async def import_media(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    """Import a video or image (kind='video'|'image'). Stores the original
    untouched, probes dimensions / duration / alpha, renders a poster."""
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    media_bytes = await file.read()
    if not media_bytes:
        raise HTTPException(400, "empty file")

    try:
        record = get_store().import_media(
            media_bytes=media_bytes,
            filename=file.filename or "import.bin",
            mime_type=file.content_type or "",
            metadata=meta_dict,
        )
    except ValueError as e:
        raise HTTPException(415, str(e))
    return record.to_dict()


_FOLDER_AUDIO_EXTS = {
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".m4a",
    ".aac",
    ".opus",
    ".aif",
    ".aiff",
    ".wma",
}


class ImportFolderRequest(BaseModel):
    path: Optional[str] = None
    recursive: bool = True


@router.post("/import-folder")
def import_folder(
    req: ImportFolderRequest = Body(default=ImportFolderRequest()),
) -> dict[str, Any]:
    """Add a local folder of audio as a playlist, REFERENCE-IN-PLACE: each file
    becomes a library entry that points at the on-disk file (no copy), so it
    plays / analyses like any track. With no ``path``, opens a native folder
    picker. Returns the created entries; the caller builds the setlist."""
    folder = req.path
    if not folder:
        from backend.core.folder_dialog import pick_folder

        folder = pick_folder(title="Choose a music folder to add as a playlist")
    if not folder:
        return {"cancelled": True, "folder": None, "entries": []}
    root = Path(folder)
    if not root.is_dir():
        raise HTTPException(400, f"not a folder: {folder!r}")
    paths = root.rglob("*") if req.recursive else root.iterdir()
    files = sorted(
        (p for p in paths if p.is_file() and p.suffix.lower() in _FOLDER_AUDIO_EXTS),
        key=lambda p: str(p).lower(),
    )
    store = get_store()
    entries: list[dict[str, Any]] = []
    for f in files:
        rec = store.register_reference(str(f), {"source": "folder"})
        if rec is not None:
            entries.append(rec.to_dict())
    return {
        "cancelled": False,
        "folder": str(root),
        "name": root.name,
        "entries": entries,
    }


@router.patch("/entries/{entry_id}")
def update_entry(entry_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    record = get_store().update_entry(entry_id, patch)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.post("/entries/{entry_id}/play")
def register_play(entry_id: str) -> dict[str, Any]:
    """Increment the persistent play counter. The player calls this when a
    track starts. Survives restarts (SQLite), and metadata edits / re-analysis
    leave it intact (upsert_entry never writes play_count)."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    new_count = store.db.increment_play_count(entry_id)
    if new_count is None:
        # On disk but missing a DB row (added out-of-band): sync, then retry.
        record = store.get_entry(entry_id)
        if record is None:
            raise HTTPException(404, f"Entry {entry_id!r} not found")
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001
        meta = _read_metadata(entry_dir) if entry_dir is not None else None
        store._sync_record_to_db(record, meta or {})  # noqa: SLF001
        new_count = store.db.increment_play_count(entry_id) or 1
    return {"id": entry_id, "play_count": new_count}


class SuggestRequest(BaseModel):
    target_duration_sec: float = 1800.0
    bpm_min: Optional[float] = None
    bpm_max: Optional[float] = None
    harmonic: bool = True
    flow: str = "steady"
    genre: Optional[str] = None
    query: Optional[str] = None
    seed_id: Optional[str] = None
    max_tracks: int = 60


@router.post("/suggest-playlist")
def suggest_playlist_endpoint(req: SuggestRequest = Body(...)) -> dict[str, Any]:
    """Build an analysis-driven playlist (harmonic + bpm-flow sequencing) that
    fits the requested time budget. Needs the DB, where analysis lives."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    from .suggester import suggest_playlist

    return suggest_playlist(
        store.db,
        target_duration_sec=req.target_duration_sec,
        bpm_min=req.bpm_min,
        bpm_max=req.bpm_max,
        harmonic=req.harmonic,
        flow=req.flow,
        genre=req.genre,
        query=req.query,
        seed_id=req.seed_id,
        max_tracks=req.max_tracks,
    )


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str) -> dict[str, Any]:
    ok = get_store().delete_entry(entry_id)
    if not ok:
        raise HTTPException(
            404, f"Entry {entry_id!r} not found or could not be deleted"
        )
    return {"deleted": entry_id}


@router.get("/setlists")
def list_setlists() -> dict[str, Any]:
    """Return local DJ setlist JSON files stored next to the library.

    Setlists are still browser-local for editing, but this lets a checkout ship
    curated starter sets that the frontend can merge into localStorage.
    """
    store = get_store()
    setlists_dir = store.root.parent / "setlists"
    out: list[dict[str, Any]] = []
    if setlists_dir.is_dir():
        for path in sorted(setlists_dir.glob("*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                log.warning("library.setlists: skipping %s: %s", path, e)
                continue
            if not isinstance(payload, dict):
                continue
            if not payload.get("id") or not isinstance(payload.get("entries"), list):
                continue
            out.append(
                {
                    "id": str(payload.get("id")),
                    "name": str(payload.get("name") or path.stem),
                    "entries": payload.get("entries") or [],
                    "createdAt": int(payload.get("createdAt") or 0),
                    "updatedAt": int(payload.get("updatedAt") or 0),
                    "notes": str(payload.get("notes") or ""),
                    "source": str(path),
                }
            )
    return {"setlists": out, "count": len(out), "root": str(setlists_dir)}


@router.get("/{entry_id}/bundle")
def download_bundle(entry_id: str) -> Response:
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analysis: Optional[dict[str, Any]] = None
    stems: list[dict[str, Any]] = []
    midis: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if store.db is not None:
        analysis = store.db.get_analysis(entry_id)
        stems = store.db.list_stems(entry_id)
        midis = store.db.list_midis(entry_id)
        # Edges where entry is either parent or child.
        edges = store.db.list_relations(from_id=entry_id) + store.db.list_relations(
            to_id=entry_id
        )

    data = build_bundle_bytes(
        entry_id=entry_id,
        record=record.to_dict(),
        audio_path=audio_path,
        metadata_path=metadata_path,
        analysis=analysis,
        stems=stems,
        midis=midis,
        lineage_edges=edges,
    )

    safe_title = "".join(
        c if c.isalnum() or c in "-_." else "_" for c in (record.title or "entry")
    )[:60]
    filename = f"{safe_title}_{entry_id[:8]}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{entry_id}/lineage")
def get_lineage(entry_id: str, depth: int = 3) -> dict[str, Any]:
    """Return nodes + edges within ``depth`` hops of ``entry_id``.

    BFS over the ``relations`` table in both directions (parents AND
    children). Cheap because edges are indexed both ways."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    depth = max(0, min(int(depth), 10))
    seen_ids: set[str] = {entry_id}
    edges: list[dict[str, Any]] = []
    frontier: list[str] = [entry_id]
    for _ in range(depth):
        next_frontier: list[str] = []
        for node_id in frontier:
            outgoing = store.db.list_relations(from_id=node_id)
            incoming = store.db.list_relations(to_id=node_id)
            for e in outgoing + incoming:
                edges.append(e)
                for nb in (e["from_id"], e["to_id"]):
                    if nb not in seen_ids:
                        seen_ids.add(nb)
                        next_frontier.append(nb)
        frontier = next_frontier
        if not frontier:
            break

    # Materialize node payloads for everything we touched.
    nodes: list[dict[str, Any]] = []
    for node_id in seen_ids:
        node_row = store.db.get_entry(node_id)
        if node_row is not None:
            nodes.append(
                {
                    "id": node_id,
                    "kind": "entry",
                    "title": node_row.get("title"),
                    "source": node_row.get("source"),
                    "duration_sec": node_row.get("duration_sec"),
                }
            )
        else:
            # Stem / midi / external label — keep it in the graph
            # without a full row so the visualization can show it as
            # a placeholder.
            nodes.append({"id": node_id, "kind": "external"})

    # Dedup edges by (from, to, kind).
    seen_edges = set()
    deduped_edges: list[dict[str, Any]] = []
    for e in edges:
        key = (e["from_id"], e["to_id"], e["kind"])
        if key in seen_edges:
            continue
        seen_edges.add(key)
        deduped_edges.append(e)

    return {"root": entry_id, "nodes": nodes, "edges": deduped_edges}


@router.get("/_all/stems")
def list_all_stems() -> dict[str, Any]:
    """Return every stem across every entry, joined to the parent
    entry's title for grouping in the UI."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out: list[dict[str, Any]] = []
    for entry in store.db.list_entries():
        for stem in store.db.list_stems(entry["id"]):
            stem_payload = dict(stem)
            stem_payload["parent_title"] = entry.get("title")
            stem_payload["parent_id"] = entry["id"]
            out.append(stem_payload)
    return {"stems": out, "count": len(out)}


@router.get("/_all/midi")
def list_all_midi() -> dict[str, Any]:
    """Return every MIDI file across every entry, joined to the parent
    entry's title."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out: list[dict[str, Any]] = []
    for entry in store.db.list_entries():
        for midi in store.db.list_midis(entry["id"]):
            midi_payload = dict(midi)
            midi_payload["parent_title"] = entry.get("title")
            midi_payload["parent_id"] = entry["id"]
            out.append(midi_payload)
    return {"midis": out, "count": len(out)}


@router.get("/_graph/all")
def get_full_graph() -> dict[str, Any]:
    """Return EVERY entry + relation in the library, PLUS virtual nodes
    for stems / midis / external source-labels referenced in edges but
    not present in the entries table. Without those virtual nodes the
    genealogy view sees chimera-children as orphans (their from_id is a
    file-name string, not an entry id) and the layered layout collapses
    to one row. Cheap up to a few thousand entries; if it grows large
    we'll paginate later."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    raw_entries = store.db.list_entries()
    raw_edges = store.db.list_relations()

    entries_by_id: dict[str, dict[str, Any]] = {r["id"]: r for r in raw_entries}
    nodes: list[dict[str, Any]] = [
        {
            "id": r["id"],
            "kind": "entry",
            "title": r.get("title"),
            "source": r.get("source"),
            "duration_sec": r.get("duration_sec"),
            "model": r.get("model"),
        }
        for r in raw_entries
    ]
    seen_ids = set(entries_by_id.keys())

    # Look up stems + midis once so we can label virtual nodes nicely.
    all_stems: dict[str, dict[str, Any]] = {}
    all_midis: dict[str, dict[str, Any]] = {}
    for entry in raw_entries:
        for s in store.db.list_stems(entry["id"]):
            all_stems[s["id"]] = s
        for m in store.db.list_midis(entry["id"]):
            all_midis[m["id"]] = m

    for edge in raw_edges:
        for ref in (edge["from_id"], edge["to_id"]):
            if ref in seen_ids:
                continue
            seen_ids.add(ref)
            if ref in all_stems:
                stem = all_stems[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "stem",
                        "title": stem.get("stem_name") or ref,
                        "source": "stem",
                        "model": stem.get("model"),
                    }
                )
            elif ref in all_midis:
                midi = all_midis[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "midi",
                        "title": Path(midi.get("midi_path") or ref).stem,
                        "source": "midi",
                        "model": midi.get("engine"),
                    }
                )
            else:
                # Chimera source-label or external reference.
                nodes.append(
                    {
                        "id": ref,
                        "kind": "external",
                        "title": ref,
                        "source": "external",
                    }
                )

    return {"nodes": nodes, "edges": raw_edges, "count": len(nodes)}


@router.post("/import")
async def import_entry(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "empty file")

    record = get_store().import_blob(
        audio_bytes=audio_bytes,
        filename=file.filename or "import.wav",
        mime_type=file.content_type or "audio/wav",
        metadata=meta_dict,
    )
    return record.to_dict()
