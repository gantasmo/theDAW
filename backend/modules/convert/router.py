"""Generic media conversion via FFmpeg.

A single "convert anything to anything (sensible)" endpoint set used by the
right-click "Convert to..." menu in the app and by the Windows Explorer shell
menu. Reuses the shared FFmpeg helper (``backend/lib/ffmpeg.py``) and the library
store, so it inherits the bundled ffmpeg binary resolved on PATH by the desktop
app.

Conversion rules (by source media kind):
- audio  -> audio
- video  -> video, audio (extract), gif
- image  -> image
Unknown sources are permitted to attempt any target (ffmpeg decides).
"""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from ...lib import ffmpeg
from ..library.router import get_store as get_library_store

router = APIRouter(tags=["convert"])


# --- format catalog -------------------------------------------------------

# Each target format: the container/extension, its media kind, the mime type for
# the download, a human label, and the ffmpeg OUTPUT args (codec/quality). Input
# is auto-decoded by ffmpeg, so only output args are needed. Audio targets carry
# -vn so converting a video (or art-bearing audio) cleanly extracts the audio.
FORMATS: dict[str, dict] = {
    # audio
    "wav": {
        "ext": "wav",
        "kind": "audio",
        "mime": "audio/wav",
        "label": "WAV (PCM 16-bit)",
        "args": ["-vn", "-c:a", "pcm_s16le"],
    },
    "wav24": {
        "ext": "wav",
        "kind": "audio",
        "mime": "audio/wav",
        "label": "WAV (PCM 24-bit)",
        "args": ["-vn", "-c:a", "pcm_s24le"],
    },
    "flac": {
        "ext": "flac",
        "kind": "audio",
        "mime": "audio/flac",
        "label": "FLAC (lossless)",
        "args": ["-vn", "-c:a", "flac"],
    },
    "mp3": {
        "ext": "mp3",
        "kind": "audio",
        "mime": "audio/mpeg",
        "label": "MP3 (320k)",
        "args": ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"],
    },
    "ogg": {
        "ext": "ogg",
        "kind": "audio",
        "mime": "audio/ogg",
        "label": "OGG Vorbis",
        "args": ["-vn", "-c:a", "libvorbis", "-q:a", "6"],
    },
    "opus": {
        "ext": "opus",
        "kind": "audio",
        "mime": "audio/opus",
        "label": "Opus",
        "args": ["-vn", "-c:a", "libopus", "-b:a", "192k"],
    },
    "m4a": {
        "ext": "m4a",
        "kind": "audio",
        "mime": "audio/mp4",
        "label": "M4A (AAC 256k)",
        "args": ["-vn", "-c:a", "aac", "-b:a", "256k"],
    },
    "aiff": {
        "ext": "aiff",
        "kind": "audio",
        "mime": "audio/aiff",
        "label": "AIFF",
        "args": ["-vn", "-c:a", "pcm_s16be"],
    },
    # video
    "mp4": {
        "ext": "mp4",
        "kind": "video",
        "mime": "video/mp4",
        "label": "MP4 (H.264)",
        "args": [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
        ],
    },
    "mov": {
        "ext": "mov",
        "kind": "video",
        "mime": "video/quicktime",
        "label": "MOV (H.264)",
        "args": [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
        ],
    },
    "mkv": {
        "ext": "mkv",
        "kind": "video",
        "mime": "video/x-matroska",
        "label": "MKV (H.264)",
        "args": [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
        ],
    },
    "webm": {
        "ext": "webm",
        "kind": "video",
        "mime": "video/webm",
        "label": "WebM (VP9)",
        "args": [
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "30",
            "-c:a",
            "libopus",
            "-b:a",
            "192k",
        ],
    },
    "gif": {
        "ext": "gif",
        "kind": "video",
        "mime": "image/gif",
        "label": "GIF (animated)",
        "args": ["-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0"],
    },
    # image
    "png": {
        "ext": "png",
        "kind": "image",
        "mime": "image/png",
        "label": "PNG",
        "args": ["-frames:v", "1"],
    },
    "jpg": {
        "ext": "jpg",
        "kind": "image",
        "mime": "image/jpeg",
        "label": "JPEG",
        "args": ["-frames:v", "1", "-q:v", "2"],
    },
    "webp": {
        "ext": "webp",
        "kind": "image",
        "mime": "image/webp",
        "label": "WebP",
        "args": ["-frames:v", "1", "-q:v", "85"],
    },
    "bmp": {
        "ext": "bmp",
        "kind": "image",
        "mime": "image/bmp",
        "label": "BMP",
        "args": ["-frames:v", "1"],
    },
    "tiff": {
        "ext": "tiff",
        "kind": "image",
        "mime": "image/tiff",
        "label": "TIFF",
        "args": ["-frames:v", "1"],
    },
}

# Which target kinds a source kind may produce.
ALLOWED_TARGETS: dict[str, set[str]] = {
    "audio": {"audio"},
    "video": {"video", "audio"},
    "image": {"image"},
}

_AUDIO_EXT = {
    ".wav",
    ".flac",
    ".mp3",
    ".ogg",
    ".opus",
    ".m4a",
    ".aac",
    ".aiff",
    ".aif",
    ".wma",
}
_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".gif", ".m4v", ".flv", ".wmv"}
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".heic"}


def _kind_of(suffix: str) -> str:
    s = suffix.lower()
    if s in _AUDIO_EXT:
        return "audio"
    if s in _VIDEO_EXT:
        return "video"
    if s in _IMAGE_EXT:
        return "image"
    return "unknown"


def _safe_stem(name: str) -> str:
    # Strip a trailing file extension only when it really looks like one, so a
    # title containing a slash (e.g. "AC/DC") is not truncated by Path parsing.
    head, sep, tail = name.rpartition(".")
    stem = head if sep and 1 <= len(tail) <= 5 and tail.isalnum() else name
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    return stem[:120] or "converted"


def _ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg was not found on PATH. The desktop app bundles it; if running the "
            "backend standalone, install ffmpeg or add it to PATH.",
        )


async def _convert_to_bytes(src: Path, fmt: str, src_kind: str) -> tuple[bytes, dict]:
    spec = FORMATS.get(fmt)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unknown target format '{fmt}'.")

    if src_kind != "unknown" and spec["kind"] not in ALLOWED_TARGETS.get(
        src_kind, set()
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot convert a {src_kind} file to {spec['label']}.",
        )

    tmp = Path(tempfile.mkdtemp(prefix="convert_"))
    out = tmp / f"out.{spec['ext']}"
    try:
        await ffmpeg.render(src, out, filter_args=[], extra_out_args=spec["args"])
        data = await asyncio.to_thread(out.read_bytes)
        return data, spec
    except ffmpeg.FFmpegError as e:
        raise HTTPException(
            status_code=422, detail=f"Conversion failed: {str(e)[-400:]}"
        )
    finally:
        ffmpeg.cleanup(tmp)


def _download_headers(stem: str, ext: str) -> dict:
    return {"Content-Disposition": f'attachment; filename="{stem}.{ext}"'}


class ConvertRequest(BaseModel):
    format: str


# --- endpoints ------------------------------------------------------------


@router.get("/formats")
def list_formats() -> dict:
    """Catalog of target formats plus the source-kind -> target-kind rules so the
    UI can show only the conversions that make sense for a given item."""
    return {
        "formats": [
            {
                "id": fid,
                "ext": v["ext"],
                "kind": v["kind"],
                "label": v["label"],
                "mime": v["mime"],
            }
            for fid, v in FORMATS.items()
        ],
        "rules": {k: sorted(v) for k, v in ALLOWED_TARGETS.items()},
    }


@router.post("/library/{entry_id}")
async def convert_library_entry(entry_id: str, body: ConvertRequest) -> Response:
    """Convert a library entry (audio/video/image) to the requested format and
    return the converted bytes as a download."""
    _ensure_ffmpeg()
    store = get_library_store()

    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Library entry not found.")

    src = store.get_audio_path(entry_id)
    if src is None or not src.exists():
        src = store.get_media_path(entry_id)
    if src is None or not src.exists():
        raise HTTPException(
            status_code=404, detail="Source media file not found on disk."
        )

    src_kind = _kind_of(src.suffix)
    data, spec = await _convert_to_bytes(src, body.format, src_kind)

    meta = record.to_dict() if hasattr(record, "to_dict") else {}
    stem = _safe_stem(str(meta.get("title") or src.stem))
    return Response(
        content=data,
        media_type=spec["mime"],
        headers=_download_headers(stem, spec["ext"]),
    )


@router.post("/file")
async def convert_upload(
    file: UploadFile = File(...), format: str = Form(...)
) -> Response:
    """Convert an uploaded file to the requested format and return the bytes.
    Used for arbitrary files that are not library entries."""
    _ensure_ffmpeg()

    tmp = Path(tempfile.mkdtemp(prefix="convert_up_"))
    in_suffix = Path(file.filename or "input").suffix or ".bin"
    src = tmp / f"input{in_suffix}"
    try:
        await ffmpeg.stream_upload_to(src, file)
        src_kind = _kind_of(in_suffix)
        data, spec = await _convert_to_bytes(src, format, src_kind)
        stem = _safe_stem(file.filename or "converted")
        return Response(
            content=data,
            media_type=spec["mime"],
            headers=_download_headers(stem, spec["ext"]),
        )
    finally:
        ffmpeg.cleanup(tmp)
