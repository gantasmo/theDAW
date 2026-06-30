"""TasmoFile — read and write .tasmo project files (ZIP + MsgPack)."""

from __future__ import annotations
import hashlib
import json
import logging
import zipfile
from pathlib import Path
from datetime import datetime, timezone

import msgpack

from backend.modules.project.tasmo_project import TasmoProject

log = logging.getLogger(__name__)

TASMO_COMMENT = b"TASMOv1"
CURRENT_FORMAT_VERSION = 1
SOFT_SIZE_WARN_BYTES = 500 * 1024 * 1024  # 500 MB


class TasmoFile:
    """Read and write .tasmo project files."""

    @staticmethod
    def save(
        project: TasmoProject,
        path: str,
        audio_files: dict[str, bytes] | None = None,
        vst_presets: dict[str, bytes] | None = None,
        embed_audio: bool = False,
    ) -> dict:
        """Write a .tasmo file. Returns manifest dict.

        When ``embed_audio`` is True (and no explicit ``audio_files`` are
        supplied), each clip's on-disk audio is read into the archive and the
        clip's ``audio_file`` is rewritten to a portable in-zip path
        (``audio/<name>``), so the project round-trips on another machine.
        """
        project.modified_at = datetime.now(timezone.utc).isoformat()
        if embed_audio and audio_files is None:
            audio_files = _gather_embedded_audio(project)
        project_bytes = msgpack.packb(project.model_dump(), use_bin_type=True) or b""

        manifest = {
            "format": "tasmo",
            "format_version": CURRENT_FORMAT_VERSION,
            "thedaw_version": "0.1.0",
            "project_name": project.project_name,
            "created_at": project.created_at,
            "modified_at": project.modified_at,
            "audio_mode": "embedded" if audio_files else "linked",
            "total_tracks": len(project.tracks),
            "total_clips": sum(len(t.clips) for t in project.tracks),
            "sample_rate": project.sample_rate,
        }

        total_size = len(project_bytes)
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.comment = TASMO_COMMENT
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            zf.writestr("project.msgpack", project_bytes)

            if audio_files:
                for name, data in audio_files.items():
                    zf.writestr(f"audio/{name}", data)
                    total_size += len(data)

            if vst_presets:
                for name, data in vst_presets.items():
                    zf.writestr(f"vst_presets/{name}", data)

        if total_size > SOFT_SIZE_WARN_BYTES:
            log.warning(
                "Large .tasmo file: %d MB (soft warn at %d MB). Consider 'linked' audio mode.",
                total_size // (1024 * 1024),
                SOFT_SIZE_WARN_BYTES // (1024 * 1024),
            )

        return manifest

    @staticmethod
    def load(path: str, media_dir: str | None = None) -> tuple[TasmoProject, dict]:
        """Read a .tasmo file. Returns (project, manifest).

        If the archive embeds audio, it is extracted to ``media_dir`` (default:
        a ``<stem>_media`` folder beside the .tasmo) and each clip's
        ``audio_file`` is relinked to the extracted on-disk path.
        """
        if not Path(path).is_file():
            raise FileNotFoundError(f".tasmo file not found: {path}")

        with zipfile.ZipFile(path, "r") as zf:
            # manifest
            try:
                manifest = json.loads(zf.read("manifest.json"))
            except KeyError:
                raise ValueError("Invalid .tasmo: missing manifest.json")

            # Format version check
            fv = manifest.get("format_version", 1)
            if fv > CURRENT_FORMAT_VERSION:
                raise ValueError(
                    f"This .tasmo uses format v{fv}, but theDAW supports up to "
                    f"v{CURRENT_FORMAT_VERSION}. Please update theDAW."
                )

            # Apply migrations if needed
            # (currently only v1, so no migration needed yet)

            # Project data
            try:
                raw = zf.read("project.msgpack")
            except KeyError:
                raise ValueError("Invalid .tasmo: missing project.msgpack")

            project_data = msgpack.unpackb(raw, raw=False)
            project = TasmoProject.model_validate(project_data)

            if manifest.get("audio_mode") == "embedded":
                target = (
                    Path(media_dir)
                    if media_dir
                    else Path(path).parent / f"{Path(path).stem}_media"
                )
                _extract_and_relink(zf, project, target)

            return project, manifest

    @staticmethod
    def info(path: str) -> dict:
        """Read only the manifest from a .tasmo (no full project load)."""
        with zipfile.ZipFile(path, "r") as zf:
            try:
                return json.loads(zf.read("manifest.json"))
            except KeyError:
                raise ValueError("Invalid .tasmo: missing manifest.json")

    @staticmethod
    def list_audio(path: str) -> list[str]:
        """List embedded audio file names inside a .tasmo."""
        with zipfile.ZipFile(path, "r") as zf:
            return [n for n in zf.namelist() if n.startswith("audio/")]

    @staticmethod
    def extract_audio(path: str, output_dir: str) -> list[str]:
        """Extract all embedded audio files from a .tasmo to disk."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        extracted = []
        with zipfile.ZipFile(path, "r") as zf:
            for name in zf.namelist():
                if name.startswith("audio/"):
                    zf.extract(name, out)
                    extracted.append(str(out / name))
        return extracted


def _gather_embedded_audio(project: TasmoProject) -> dict[str, bytes]:
    """Read each clip's on-disk audio into bytes for embedding.

    Files referenced by more than one clip are stored once. Mutates the
    project in place: every embedded clip's ``audio_file`` is rewritten to its
    in-zip path (``audio/<name>``) and ``audio_file_checksum`` is filled in.
    Clips whose audio_file is missing/already-relative are left untouched.
    Returns a mapping of {archive_name: bytes}.
    """
    audio_files: dict[str, bytes] = {}
    path_to_name: dict[str, str] = {}
    used_names: set[str] = set()
    for track in project.tracks:
        for clip in track.clips:
            src = clip.audio_file
            if not src or src.startswith("audio/"):
                continue
            sp = Path(src)
            if not sp.is_file():
                continue  # cannot embed a file that is not on disk
            key = str(sp.resolve())
            if key in path_to_name:
                clip.audio_file = f"audio/{path_to_name[key]}"
                continue
            data = sp.read_bytes()
            name = _unique_name(sp.name, used_names)
            used_names.add(name)
            path_to_name[key] = name
            audio_files[name] = data
            clip.audio_file = f"audio/{name}"
            clip.audio_file_checksum = "sha256:" + hashlib.sha256(data).hexdigest()
    return audio_files


def _extract_and_relink(
    zf: zipfile.ZipFile, project: TasmoProject, media_dir: Path
) -> None:
    """Extract embedded clip audio to ``media_dir`` and relink clip references.

    Each clip whose ``audio_file`` points at an ``audio/<name>`` entry is
    rewritten to the extracted on-disk path. Each archive entry is extracted
    at most once even if several clips share it.
    """
    names = set(zf.namelist())
    extracted: dict[str, str] = {}
    for track in project.tracks:
        for clip in track.clips:
            ref = clip.audio_file
            if not ref or not ref.startswith("audio/") or ref not in names:
                continue
            if ref not in extracted:
                media_dir.mkdir(parents=True, exist_ok=True)
                out = media_dir / Path(ref).name
                out.write_bytes(zf.read(ref))
                extracted[ref] = str(out)
            clip.audio_file = extracted[ref]


def _unique_name(name: str, used: set[str]) -> str:
    """Return ``name`` or a ``stem_N.ext`` variant not present in ``used``."""
    if name not in used:
        return name
    stem = Path(name).stem
    ext = Path(name).suffix
    i = 1
    while f"{stem}_{i}{ext}" in used:
        i += 1
    return f"{stem}_{i}{ext}"
