"""Filesystem-backed library store.

Layout under the library root (default: `<project>/data/generations/`,
overridable via `theDAW_GENERATIONS_DIR`):

    <library_root>/
        <entry_id>/
            metadata.json     # entry record (see ENTRY_FIELDS below)
            <audio_filename>  # the audio file
            [spectrogram_*.png ...]   # optional, written by the generate flow

For generate outputs `entry_id = "{job_id}_{index:02d}"`. For imports we
mint a UUID. The `metadata.json` is the source of truth — any user-mutable
field (favorite, rating, tags, notes) is merged in there.

This module is intentionally storage-only: it does NOT depend on FastAPI
so it can be reused by an eventual `S3Provider` / `DriveProvider` that
swaps the filesystem operations for cloud APIs.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

from .db import LibraryDB

log = logging.getLogger(__name__)


# Fields a frontend client is allowed to modify on an entry. Everything
# else in metadata.json is owned by the backend (filenames, paths,
# timestamps, the generation params we recorded at save time).
# `chimera_sources` is included because the backend doesn't know about
# the user-facing Chimera stack labels at generation time — the frontend
# PATCHes them after the mashup runs.
USER_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {"favorite", "rating", "tags", "notes", "title", "chimera_sources"}
)


@dataclass
class LibraryRecord:
    """Public-facing entry record. Mirrors the frontend `LibraryEntry` interface
    minus the inline `audioBlob` — clients fetch the audio via the
    `audio_url` field instead."""

    id: str
    title: str
    prompt: str
    negative_prompt: str
    model: str
    duration: float
    steps: int
    cfg: float
    seed: int
    audio_url: str
    audio_filename: str
    mime_type: str
    file_size_bytes: int
    timestamp: str
    favorite: bool
    rating: Optional[str]
    tags: list[str]
    notes: str
    source: str
    chimera_sources: list[str] = field(default_factory=list)
    # Optional pointers to extra artifacts on disk.
    spectrogram_paths: dict[str, Optional[str]] = field(default_factory=dict)
    # Media (video / image) entries. 'audio' keeps the original contract;
    # 'video' / 'image' carry a stream URL, a poster thumbnail, pixel
    # dimensions, and an alpha flag (overlay-capable when True).
    kind: str = "audio"
    media_url: Optional[str] = None
    thumb_url: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    has_alpha: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "prompt": self.prompt,
            "negative_prompt": self.negative_prompt,
            "model": self.model,
            "duration": self.duration,
            "steps": self.steps,
            "cfg": self.cfg,
            "seed": self.seed,
            "audio_url": self.audio_url,
            "audio_filename": self.audio_filename,
            "mime_type": self.mime_type,
            "file_size_bytes": self.file_size_bytes,
            "timestamp": self.timestamp,
            "favorite": self.favorite,
            "rating": self.rating,
            "tags": list(self.tags),
            "notes": self.notes,
            "source": self.source,
            "chimera_sources": list(self.chimera_sources),
            "spectrogram_paths": dict(self.spectrogram_paths),
            "kind": self.kind,
            "media_url": self.media_url,
            "thumb_url": self.thumb_url,
            "width": self.width,
            "height": self.height,
            "has_alpha": self.has_alpha,
        }


def default_library_root(project_root: Path) -> Path:
    """Resolve the library root path. Env override wins; otherwise it lives
    alongside the existing generate artifacts so old data is picked up."""
    configured = os.getenv("theDAW_GENERATIONS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return project_root / "data" / "generations"


def _audio_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/audio/{entry_id}"


def _media_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}"


def _thumb_url_for(api_prefix: str, entry_id: str) -> str:
    return f"{api_prefix}/media/{entry_id}/thumb"


_MEDIA_EXTS = {
    ".mp4",
    ".webm",
    ".mov",
    ".mkv",
    ".m4v",
    ".avi",
    ".ogv",
    ".png",
    ".webp",
    ".gif",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".avif",
    ".apng",
}


def _resolve_media_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve a video/image file for a media entry: the declared name
    first, then the first recognized media file in the directory (the
    poster thumbnail is skipped)."""
    declared = meta.get("media_filename") or meta.get("filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in sorted(entry_dir.iterdir()):
        if path.name == "thumb.jpg":
            continue
        if path.is_file() and path.suffix.lower() in _MEDIA_EXTS:
            return path
    return None


def _metadata_path(entry_dir: Path) -> Path:
    return entry_dir / "metadata.json"


def _read_metadata(entry_dir: Path) -> Optional[dict[str, Any]]:
    p = _metadata_path(entry_dir)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("library.store: failed to read %s: %s", p, e)
        return None


def _write_metadata(entry_dir: Path, payload: dict[str, Any]) -> None:
    p = _metadata_path(entry_dir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(p)


def _resolve_audio_file(entry_dir: Path, meta: dict[str, Any]) -> Optional[Path]:
    """Resolve the audio file for an entry. Try the metadata-declared name
    first, then any first audio file in the entry directory."""
    # Reference-in-place entry (folder -> playlist): the audio lives OUTSIDE the
    # library at source_path and is never copied in. Resolve straight to it so
    # serving, analysis, and listing all read the original file.
    source_path = meta.get("source_path")
    if source_path:
        ref = Path(source_path)
        if ref.is_file():
            return ref
    declared = meta.get("filename") or meta.get("audio_filename")
    if declared:
        candidate = entry_dir / declared
        if candidate.is_file():
            return candidate
    for path in entry_dir.iterdir():
        if path.is_file() and path.suffix.lower() in {
            ".wav",
            ".mp3",
            ".flac",
            ".ogg",
            ".m4a",
        }:
            return path
    return None


def _record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord from a metadata.json payload. Returns None if
    the directory has no resolvable audio file AND no CDN URL fallback."""
    # ── Suno API-compatible format normalization ─────────────────────
    # If metadata came from a Suno External API cache (has "inferred" dict),
    # flatten inferred fields to top-level so downstream field reads work.
    # No-op on normal theDAW metadata (no "inferred" key exists).
    # Shallow-copy to avoid mutating the caller's dict (preserves DB fidelity).
    inferred = meta.get("inferred")
    if isinstance(inferred, dict):
        meta = dict(meta)
        for k, v in inferred.items():
            if meta.get(k) is None:
                meta[k] = v

        # Pull nested Suno API metadata.metadata fields up to top-level.
        # Only runs when "inferred" was present (Suno format marker).
        api_meta = meta.get("metadata")
        if isinstance(api_meta, dict):
            if api_meta.get("lyrics") and not meta.get("lyrics"):
                meta["lyrics"] = api_meta["lyrics"]
            if api_meta.get("style") and not meta.get("style"):
                meta["style"] = api_meta["style"]
            if api_meta.get("description") and not meta.get("prompt"):
                meta["prompt"] = api_meta["description"]

    entry_id = entry_dir.name

    # Media (video / image) entries take a separate path: they resolve a
    # media file (not audio), carry a poster thumbnail + dimensions, and
    # stream from /media/<id> rather than /audio/<id>.
    kind = str(meta.get("kind") or "audio")
    if kind in ("video", "image"):
        return _media_record_from_metadata(entry_dir, meta, api_prefix, kind)

    audio_file = _resolve_audio_file(entry_dir, meta)

    # CHANGED: allow CDN-only entries (no local audio file) when a
    # cdn_audio_url is present in metadata — used by Suno cache import.
    if audio_file is None and not meta.get("cdn_audio_url"):
        return None

    size = 0
    audio_fname = ""
    if audio_file is not None:
        try:
            size = audio_file.stat().st_size
        except OSError:
            size = 0
        audio_fname = audio_file.name
    else:
        audio_fname = meta.get("audio_filename") or f"{entry_id}.mp3"

    timestamp = meta.get("timestamp")
    if not timestamp:
        # Fall back to created_at ISO string (Suno cache format).
        created_at_str = meta.get("created_at")
        if isinstance(created_at_str, str) and created_at_str:
            timestamp = created_at_str
        else:
            # Fall back to saved_at unix seconds → ISO.
            saved_at = meta.get("saved_at")
            if isinstance(saved_at, (int, float)):
                timestamp = (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
                )
            elif audio_file is not None:
                try:
                    timestamp = (
                        time.strftime(
                            "%Y-%m-%dT%H:%M:%S", time.gmtime(audio_file.stat().st_mtime)
                        )
                        + "Z"
                    )
                except OSError:
                    timestamp = ""
            else:
                timestamp = ""

    # Older metadata used `model_name` and `cfg_scale`; the new convention is
    # `model` and `cfg`. Read both so the library list works for entries
    # written before this refactor.
    model = meta.get("model") or meta.get("model_name") or ""
    cfg_val = meta.get("cfg")
    if cfg_val is None:
        cfg_val = meta.get("cfg_scale", 0.0)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or meta.get("filename") or audio_fname),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(model),
        duration=float(meta.get("duration") or 0.0),
        steps=int(meta.get("steps") or 0),
        cfg=float(cfg_val or 0.0),
        seed=int(meta.get("seed") or 0),
        audio_url=_audio_url_for(api_prefix, entry_id),
        audio_filename=audio_fname,
        mime_type=str(meta.get("mime_type") or "audio/mpeg"),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=meta.get("rating")
        if meta.get("rating") in ("like", "dislike")
        else None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "generate"),
        chimera_sources=list(meta.get("chimera_sources") or []),
        spectrogram_paths=dict(meta.get("spectrogram_paths") or {}),
    )


def _media_record_from_metadata(
    entry_dir: Path,
    meta: dict[str, Any],
    api_prefix: str,
    kind: str,
) -> Optional[LibraryRecord]:
    """Build a LibraryRecord for a video/image entry. Returns None when no
    media file resolves on disk."""
    entry_id = entry_dir.name
    media_file = _resolve_media_file(entry_dir, meta)
    if media_file is None:
        return None

    try:
        size = media_file.stat().st_size
    except OSError:
        size = 0

    timestamp = meta.get("timestamp")
    if not timestamp:
        saved_at = meta.get("saved_at")
        if isinstance(saved_at, (int, float)):
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(saved_at)) + "Z"
        else:
            timestamp = ""

    has_thumb = (entry_dir / "thumb.jpg").is_file()
    # audio_url points at the media stream too, so generic consumers that
    # read audio_url never hit an empty/broken URL for a media entry.
    media_url = _media_url_for(api_prefix, entry_id)

    return LibraryRecord(
        id=entry_id,
        title=str(meta.get("title") or media_file.name),
        prompt=str(meta.get("prompt") or ""),
        negative_prompt=str(meta.get("negative_prompt") or ""),
        model=str(meta.get("model") or "import"),
        duration=float(meta.get("duration") or 0.0),
        steps=0,
        cfg=0.0,
        seed=0,
        audio_url=media_url,
        audio_filename=media_file.name,
        mime_type=str(meta.get("mime_type") or ""),
        file_size_bytes=size,
        timestamp=timestamp,
        favorite=bool(meta.get("favorite", False)),
        rating=None,
        tags=list(meta.get("tags") or []),
        notes=str(meta.get("notes") or ""),
        source=str(meta.get("source") or "import"),
        chimera_sources=[],
        spectrogram_paths={},
        kind=kind,
        media_url=media_url,
        thumb_url=_thumb_url_for(api_prefix, entry_id) if has_thumb else None,
        width=_int_or_none(meta.get("width")),
        height=_int_or_none(meta.get("height")),
        has_alpha=bool(meta.get("has_alpha", False)),
    )


def _int_or_none(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class LibraryStore:
    """Filesystem-backed library with an attached SQLite query layer.

    Filesystem (``<root>/<entry_id>/metadata.json`` + audio) remains the
    durable source of truth. SQLite at ``<root>/library.db`` (overridable
    via ``db_path``) is a write-through query accelerator + the home for
    analysis / stems / midi / relations tables that have no filesystem
    representation.

    On init we open the DB, run schema migrations, and — if the DB is
    empty but filesystem entries exist — auto-``reindex()`` so the query
    layer is immediately useful without a manual step. Setting
    ``db_path=False`` disables the DB entirely (only for unit tests that
    pre-date the DB; the default tests run with the DB in tmp_path)."""

    def __init__(
        self,
        root: Path,
        api_prefix: str = "/api/library",
        db_path: Optional[Path] | bool = None,
    ) -> None:
        self.root = root
        self.api_prefix = api_prefix
        self.root.mkdir(parents=True, exist_ok=True)

        if db_path is False:
            self.db: Optional[LibraryDB] = None
        else:
            resolved_db_path = (
                db_path if isinstance(db_path, Path) else self.root / "library.db"
            )
            self.db = LibraryDB(resolved_db_path)
            # Auto-reindex on a fresh DB so the query layer is hot.
            if self.db.count_entries() == 0:
                self.reindex()

    # ---- Read ---------------------------------------------------------------

    def list_entries(
        self, kinds: Optional[Iterable[str]] = None
    ) -> list[LibraryRecord]:
        """List entries, optionally restricted to a set of ``kind`` values
        ('audio' | 'video' | 'image'). ``kinds=None`` returns every kind
        (used by reindex); callers that want the historical audio-only
        behavior pass ``kinds={'audio'}``."""
        if not self.root.is_dir():
            return []
        kind_set = set(kinds) if kinds is not None else None
        out: list[LibraryRecord] = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            # Generate flow has been writing data/generations/<job_id>/<index>/
            # i.e. nested two levels. Walk down one if we see no metadata.json
            # at the top.
            direct_meta = _read_metadata(child)
            if direct_meta is not None:
                record = _record_from_metadata(child, direct_meta, self.api_prefix)
                if record is not None and (kind_set is None or record.kind in kind_set):
                    out.append(record)
                continue
            for inner in sorted(child.iterdir()):
                if not inner.is_dir():
                    continue
                meta = _read_metadata(inner)
                if meta is None:
                    continue
                # Synthesize entry_id from the nested structure so listing
                # is stable across reads.
                entry_id = f"{child.name}_{inner.name}"
                # Build a record but force the id we synthesized.
                record = _record_from_metadata(inner, meta, self.api_prefix)
                if record is None:
                    continue
                if kind_set is not None and record.kind not in kind_set:
                    continue
                record.id = entry_id
                if record.kind == "audio":
                    record.audio_url = _audio_url_for(self.api_prefix, entry_id)
                else:
                    record.media_url = _media_url_for(self.api_prefix, entry_id)
                    record.audio_url = record.media_url
                out.append(record)
        return out

    def get_entry(self, entry_id: str) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        record = _record_from_metadata(entry_dir, meta, self.api_prefix)
        if record is not None:
            record.id = entry_id
            record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        return record

    def get_audio_path(self, entry_id: str) -> Optional[Path]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        return _resolve_audio_file(entry_dir, meta)

    def get_media_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the video/image file for a media entry (None for audio
        entries or unknown ids)."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir) or {}
        if str(meta.get("kind") or "audio") not in ("video", "image"):
            return None
        return _resolve_media_file(entry_dir, meta)

    def get_thumb_path(self, entry_id: str) -> Optional[Path]:
        """Resolve the poster thumbnail for a media entry, if one exists."""
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        thumb = entry_dir / "thumb.jpg"
        return thumb if thumb.is_file() else None

    # ---- Write --------------------------------------------------------------

    def update_entry(
        self, entry_id: str, patch: dict[str, Any]
    ) -> Optional[LibraryRecord]:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return None
        meta = _read_metadata(entry_dir)
        if meta is None:
            return None
        for key in USER_MUTABLE_FIELDS:
            if key not in patch:
                continue
            meta[key] = patch[key]
        # Sanitize types we expose.
        if "favorite" in meta:
            meta["favorite"] = bool(meta["favorite"])
        if "tags" in meta:
            meta["tags"] = [str(t) for t in (meta["tags"] or [])]
        if "notes" in meta:
            meta["notes"] = str(meta["notes"] or "")
        if "chimera_sources" in meta:
            raw = meta["chimera_sources"] or []
            if not isinstance(raw, list):
                raw = []
            meta["chimera_sources"] = [str(s) for s in raw]
        if meta.get("rating") not in ("like", "dislike", None):
            meta["rating"] = None
        _write_metadata(entry_dir, meta)
        record = self.get_entry(entry_id)
        if record is not None:
            self._sync_record_to_db(record, meta)
        # Favoriting a track gives it the full treatment — stems, MIDI, and a
        # score — so a starred track is always fully analyzed and notated. Each
        # job is idempotent (skipped if the artifact exists) and runs on the
        # idle-gated, serialized background queue (stems -> midi -> score).
        if bool(patch.get("favorite")):
            _maybe_enqueue_stems(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_midi(self, entry_id, source="favorite", force=True)
            _maybe_enqueue_score(self, entry_id, source="favorite", force=True)
        return record

    def delete_entry(self, entry_id: str) -> bool:
        entry_dir = self._dir_for(entry_id)
        if entry_dir is None:
            return False
        try:
            shutil.rmtree(entry_dir)
        except OSError as e:
            log.warning("library.store: failed to delete %s: %s", entry_dir, e)
            return False
        if self.db is not None:
            self.db.delete_entry(entry_id)
        return True

    def import_blob(
        self,
        audio_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower() or ".wav"
        safe_name = Path(filename).stem[:80] or "import"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(audio_bytes)

        # Read any embedded metadata (e.g., ID3 TXXX:prompt from an
        # AI-generated MP3) and merge with caller-supplied metadata.
        # Caller wins for explicit fields; embedded fills the gaps.
        from .tags import extract_embedded_tags

        embedded = extract_embedded_tags(target_path)
        meta_in = dict(metadata or {})

        def _pick(field: str, embedded_keys: list[str], default: Any) -> Any:
            if field in meta_in and meta_in[field] not in (None, ""):
                return meta_in[field]
            for ek in embedded_keys:
                if ek in embedded and embedded[ek]:
                    return embedded[ek]
            return default

        title_default = embedded.get("title") or target_name
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "filename": target_name,
            "audio_filename": target_name,
            "mime_type": mime_type,
            "title": _pick("title", ["title"], title_default),
            "prompt": _pick("prompt", ["prompt"], ""),
            "negative_prompt": _pick("negative_prompt", ["negative_prompt"], ""),
            "model": _pick("model", ["model", "generator"], "import"),
            "duration": meta_in.get("duration", 0.0),
            "steps": meta_in.get("steps", 0),
            "cfg": meta_in.get("cfg", 0.0),
            "seed": meta_in.get("seed", 0),
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "chimera_sources": list(meta_in.get("chimera_sources", [])),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "embedded_tags": embedded,
        }
        _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        assert record is not None, "freshly imported entry must resolve"
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Opt-in: enqueue background analysis / stems / midi if the
        # user has those toggles on (defaults are all OFF).
        _maybe_enqueue_analysis(self, entry_id, source="import")
        _maybe_enqueue_stems(self, entry_id, source="import")
        _maybe_enqueue_midi(self, entry_id, source="import")
        _maybe_enqueue_score(self, entry_id, source="import")
        return record

    def register_reference(
        self,
        source_path: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Optional[LibraryRecord]:
        """Register an on-disk audio file as a library entry WITHOUT copying it
        (reference-in-place). Only a small metadata.json is written into the
        library; the audio is served / analysed straight from ``source_path``.
        Used by the folder -> playlist feature. Returns None when the path is
        not a file."""
        src = Path(source_path)
        if not src.is_file():
            return None
        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        meta_in = dict(metadata or {})
        ext = src.suffix.lower().lstrip(".")
        mime = {
            "mp3": "audio/mpeg",
            "wav": "audio/wav",
            "flac": "audio/flac",
            "ogg": "audio/ogg",
            "m4a": "audio/mp4",
            "aac": "audio/aac",
            "opus": "audio/opus",
            "aif": "audio/aiff",
            "aiff": "audio/aiff",
            "wma": "audio/x-ms-wma",
        }.get(ext, "audio/mpeg")
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "source_path": str(src.resolve()),
            "filename": src.name,
            "audio_filename": src.name,
            "mime_type": mime,
            "title": meta_in.get("title") or src.stem,
            "prompt": "",
            "negative_prompt": "",
            "model": "reference",
            "duration": 0.0,
            "steps": 0,
            "cfg": 0.0,
            "seed": 0,
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "folder"),
            "chimera_sources": [],
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_metadata(entry_dir, record_meta)
        record = _record_from_metadata(entry_dir, record_meta, self.api_prefix)
        if record is None:
            return None
        record.id = entry_id
        record.audio_url = _audio_url_for(self.api_prefix, entry_id)
        self._sync_record_to_db(record, record_meta)
        # Reference tracks still benefit from BG analysis (BPM/key for mixing);
        # it reads get_audio_path, which now resolves to the external file.
        _maybe_enqueue_analysis(self, entry_id, source="import")
        return record

    def import_media(
        self,
        media_bytes: bytes,
        filename: str,
        mime_type: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> LibraryRecord:
        """Import a video or image as a library entry (kind='video'|'image').

        Stores the original file untouched, probes it for dimensions /
        duration / alpha, and renders a poster thumbnail. None of the
        audio analysis/stems/midi pipelines run for media. Raises
        ValueError for an unrecognized media extension.
        """
        from . import media as media_probe

        kind = media_probe.classify_ext(filename)
        if kind is None:
            raise ValueError(
                f"unrecognized media type for {filename!r} "
                "(expected a video or image file)"
            )

        entry_id = uuid.uuid4().hex
        entry_dir = self.root / entry_id
        entry_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower()
        safe_name = Path(filename).stem[:80] or "media"
        target_name = f"{safe_name}{suffix}"
        target_path = entry_dir / target_name
        target_path.write_bytes(media_bytes)

        probe = media_probe.probe_media(target_path, kind)
        thumb_path = entry_dir / "thumb.jpg"
        media_probe.make_thumbnail(target_path, kind, thumb_path)

        meta_in = dict(metadata or {})
        record_meta: dict[str, Any] = {
            "id": entry_id,
            "kind": kind,
            "filename": target_name,
            "media_filename": target_name,
            "mime_type": mime_type or "",
            "title": meta_in.get("title") or safe_name,
            "prompt": meta_in.get("prompt", ""),
            "negative_prompt": "",
            "model": meta_in.get("model", "import"),
            "duration": probe.get("duration") or 0.0,
            "favorite": False,
            "rating": None,
            "tags": list(meta_in.get("tags", [])),
            "notes": meta_in.get("notes", ""),
            "source": meta_in.get("source", "import"),
            "width": probe.get("width"),
            "height": probe.get("height"),
            "has_alpha": bool(probe.get("has_alpha")),
            "saved_at": time.time(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _write_metadata(entry_dir, record_meta)
        record = _media_record_from_metadata(
            entry_dir, record_meta, self.api_prefix, kind
        )
        assert record is not None, "freshly imported media must resolve"
        self._sync_record_to_db(record, record_meta)
        return record

    # ---- DB sync / reindex --------------------------------------------------

    def _sync_record_to_db(
        self,
        record: LibraryRecord,
        meta: dict[str, Any],
    ) -> None:
        if self.db is None:
            return
        payload: dict[str, Any] = {
            "id": record.id,
            "kind": record.kind,
            "title": record.title,
            "prompt": record.prompt,
            "negative_prompt": record.negative_prompt,
            "model": record.model,
            "duration": record.duration,
            "steps": record.steps,
            "cfg": record.cfg,
            "seed": record.seed,
            "mime_type": record.mime_type,
            "audio_filename": record.audio_filename,
            "file_size_bytes": record.file_size_bytes,
            "source": record.source,
            "favorite": record.favorite,
            "rating": record.rating,
            "notes": record.notes,
            "timestamp": record.timestamp,
            "tags": list(record.tags),
            "metadata_json": meta,
        }
        try:
            self.db.upsert_entry(payload)
        except Exception as e:
            log.warning("library.store: db upsert failed for %s: %s", record.id, e)

        # Chimera sources → directed lineage edges.
        sources = meta.get("chimera_sources") or []
        if isinstance(sources, list) and sources:
            for source_label in sources:
                if not source_label:
                    continue
                try:
                    self.db.add_relation(
                        from_id=str(source_label),
                        to_id=record.id,
                        kind="chimera_source_of",
                    )
                except Exception as e:
                    log.debug(
                        "library.store: relation insert failed for %s→%s: %s",
                        source_label,
                        record.id,
                        e,
                    )

    def reindex(self) -> int:
        """Walk the filesystem and upsert every entry into the DB.
        Returns the number of entries indexed. Idempotent."""
        if self.db is None:
            return 0
        count = 0
        for record in self.list_entries():
            entry_dir = self._dir_for(record.id)
            meta = _read_metadata(entry_dir) if entry_dir else None
            self._sync_record_to_db(record, meta or {})
            count += 1
        return count

    # ---- Helpers ------------------------------------------------------------

    def _dir_for(self, entry_id: str) -> Optional[Path]:
        # Direct (import or single-level generate) layout.
        direct = self.root / entry_id
        if direct.is_dir() and _metadata_path(direct).is_file():
            return direct
        # Nested generate layout: "<job_id>_<index>" maps to "<job_id>/<index>".
        if "_" in entry_id:
            job_id, _, index = entry_id.rpartition("_")
            nested = self.root / job_id / index
            if nested.is_dir() and _metadata_path(nested).is_file():
                return nested
        return None

    def all_ids(self) -> Iterable[str]:
        for record in self.list_entries():
            yield record.id


def _maybe_enqueue_analysis(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
) -> None:
    """If feature settings have ``analysis.auto_on_<source>`` enabled,
    queue a background analysis job. Failures here never block the
    import / generate flow — analysis is opt-in enrichment.

    ``source`` is either ``"import"`` or ``"generate"``.
    """
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("analysis")
    except Exception:
        return

    key = f"auto_on_{source}"
    if not settings.get(key, False):
        return

    audio_path = store.get_audio_path(entry_id)
    if audio_path is None:
        return
    entry_dir = store._dir_for(entry_id)
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    async def _run() -> None:
        from backend.modules.analysis.engine import analyze_and_persist

        analyze_and_persist(
            store.db,  # type: ignore[arg-type]  # checked above
            entry_id,
            audio_path,
            metadata_path=metadata_path,
            settings=settings,
        )

    try:
        get_background_queue().enqueue(f"analysis:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue analysis for %s: %s", entry_id, e)


def _maybe_enqueue_stems(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``stems.auto_on_<source>`` enabled, queue
    a background stem-separation job. Heavy work — relies on the
    integration-package sidecar. ``force`` bypasses the settings gate (used
    when favoriting a track), but the job is still skipped when the entry
    already has stems."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("stems")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-separate an entry that already has stems.
    try:
        if store.db.list_stems(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    stem_count = int(settings.get("default_count") or 4)

    async def _run() -> None:
        from backend.modules.stems.engine import separate_entry

        await separate_entry(
            store.db,  # type: ignore[arg-type]
            entry_id,
            audio_path,
            entry_dir,
            stems=stem_count,
        )

    try:
        get_background_queue().enqueue(f"stems:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue stems for %s: %s", entry_id, e)


def _maybe_enqueue_midi(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """If feature settings have ``midi.auto_on_<source>`` enabled, queue
    a background MIDI-conversion job. Reads ``midi.from_stems`` to
    decide whether to also convert each stem. ``force`` bypasses the settings
    gate (used when favoriting), but the job is still skipped when the entry
    already has MIDI."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    try:
        settings = get_settings_store().get_section("midi")
    except Exception:
        settings = {}

    key = f"auto_on_{source}"
    if not force and not settings.get(key, False):
        return

    # Idempotent: never re-transcribe an entry that already has MIDI.
    try:
        if store.db.list_midis(entry_id):
            return
    except Exception:
        pass

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if audio_path is None or entry_dir is None:
        return

    from_stems_flag = bool(settings.get("from_stems", True))

    async def _run() -> None:
        from backend.modules.midi.runner import convert_entry

        import asyncio

        # convert_entry is CPU/model-bound and may run piano transcription over
        # many segments. Keep it off the asyncio event loop so health/static
        # endpoints do not stall while the idle worker is busy.
        await asyncio.to_thread(
            convert_entry,
            store.db,  # type: ignore[arg-type]
            entry_id,
            audio_path,
            entry_dir,
            from_stems=from_stems_flag,
        )

    try:
        get_background_queue().enqueue(f"midi:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue midi for %s: %s", entry_id, e)


def _generate_score_for_entry(
    store: "LibraryStore", entry_id: str, entry_dir: Path
) -> None:
    """Generate a MusicXML sheet from the entry's first MIDI, stamped with the
    song title. No-op if the entry already has a sheet or has no MIDI. Runs in
    a worker thread (music21 parse is CPU-bound)."""
    if store.db is None:
        return
    try:
        from backend.modules.notation.engine import (
            midi_to_musicxml,
            register_existing_midis,
        )
    except Exception:
        return
    try:
        register_existing_midis(store.db, entry_id)
        if store.db.list_notation_artifacts(entry_id, kind="musicxml"):
            return  # already scored
        target = None
        for midi in store.db.list_midis(entry_id):
            path = midi.get("midi_path") or ""
            if path and Path(path).is_file():
                target = midi
                break
        if target is None:
            return  # nothing to score
        record = store.get_entry(entry_id)
        title = str(getattr(record, "title", "") or "")
        midi_id = str(target.get("id") or "")
        output = entry_dir / "notation" / f"{midi_id}.musicxml"
        midi_to_musicxml(
            store.db,
            entry_id=entry_id,
            midi_path=Path(target["midi_path"]),
            output_path=output,
            source_ref=midi_id,
            artifact_id=f"{midi_id}__musicxml",
            title=title,
        )
    except Exception as e:  # noqa: BLE001 - best-effort background work
        log.debug("library.store: auto-score failed for %s: %s", entry_id, e)


def _maybe_enqueue_score(
    store: "LibraryStore",
    entry_id: str,
    *,
    source: str,
    force: bool = False,
) -> None:
    """Queue a background job that turns the entry's MIDI into a titled sheet.
    Auto-score defaults ON (sheets are cheap music21 work and the job only acts
    when a MIDI already exists and no sheet does). ``force`` bypasses the
    settings gate (used when favoriting). Enqueued AFTER any MIDI job so the
    serial idle queue runs MIDI first, then this finds its output."""
    if store.db is None:
        return
    try:
        from backend.core.background_workers import get_background_queue
        from backend.modules.settings.router import get_store as get_settings_store
    except ImportError:
        return

    if not force:
        try:
            settings = get_settings_store().get_section("notation")
        except Exception:
            settings = {}
        if not settings.get(f"auto_on_{source}", True):
            return

    entry_dir = store._dir_for(entry_id)
    if entry_dir is None:
        return

    async def _run() -> None:
        import asyncio

        await asyncio.to_thread(_generate_score_for_entry, store, entry_id, entry_dir)

    try:
        get_background_queue().enqueue(f"score:{entry_id}", _run)
    except Exception as e:
        log.debug("library.store: failed to enqueue score for %s: %s", entry_id, e)
