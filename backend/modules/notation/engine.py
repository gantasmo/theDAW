"""Symbolic notation conversion helpers.

This is the conversion backbone for the notation module. It makes MIDI
artifacts first-class notation artifacts and converts between symbolic
formats:

  - ``musicxml`` and ``abc`` are produced directly by ``music21``.
  - ``pdf`` and ``svg`` are engraved by the MuseScore CLI when it is
    installed; without it those targets return ``ok=False`` with an install
    hint so callers degrade gracefully rather than raising.

Heavier engines (MT3, Audiveris, alphaTab tab export) belong behind the same
module/sidecar boundary and plug into ``convert_score`` later.
"""

from __future__ import annotations

import importlib
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from backend.modules.library.db import LibraryDB

log = logging.getLogger(__name__)

# The user is GANTASMO; sheets always carry a composer credit, so this is the
# floor when no artist is configured (Settings -> notation.artist).
DEFAULT_ARTIST = "GANTASMO"

# Media file extensions that must never appear in a sheet title (e.g. an
# imported track called "Foo.wav" should be titled "Foo"). Symbolic source
# extensions are included too so a MIDI-derived title is never "...mid".
_MEDIA_EXTENSIONS = (
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".oga",
    ".m4a",
    ".aac",
    ".aif",
    ".aiff",
    ".opus",
    ".wma",
    ".alac",
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
    ".m4v",
    ".avi",
    ".mid",
    ".midi",
    ".musicxml",
    ".xml",
)

# music21's placeholders for an untitled fragment / unset composer.
_PLACEHOLDER_TITLES = frozenset({"music21 fragment", "music21"})


def clean_title(title: str) -> str:
    """Sanitize a song title for display + engraving.

    Drops a trailing media file extension (the user never wants ``.wav`` /
    ``.mp3`` on a sheet) and treats music21's ``Music21 Fragment`` placeholder
    as empty. Returns ``""`` when nothing meaningful remains.
    """
    t = (title or "").strip()
    if not t:
        return ""
    low = t.lower()
    for ext in _MEDIA_EXTENSIONS:
        if low.endswith(ext):
            t = t[: -len(ext)].rstrip()
            break
    if t.strip().lower() in _PLACEHOLDER_TITLES:
        return ""
    return t.strip()


def artist_name() -> str:
    """The global artist/composer name (Settings -> notation.artist), stamped
    onto every generated sheet as the composer credit. Falls back to
    :data:`DEFAULT_ARTIST` so a sheet is never credited to "Music21"."""
    try:
        from backend.modules.settings.router import get_store as get_settings_store

        section = get_settings_store().get_section("notation")
        name = str((section or {}).get("artist", "") or "").strip()
    except Exception:
        name = ""
    return name or DEFAULT_ARTIST


# Targets music21 can write directly from a parsed score.
_MUSIC21_FORMATS = frozenset({"musicxml", "abc"})
# Targets that require the MuseScore CLI (engraving to print / vector).
_MUSESCORE_FORMATS = frozenset({"pdf", "svg"})
# Map an output format to the artifact ``kind`` stored in the DB.
_KIND_FOR_FORMAT = {"musicxml": "musicxml", "abc": "abc", "pdf": "pdf", "svg": "svg"}

# MuseScore CLI binary names, newest first, and common Windows install paths.
_MUSESCORE_NAMES = (
    "MuseScore4",
    "MuseScore4.exe",
    "MuseScore3",
    "MuseScore3.exe",
    "mscore",
    "musescore",
)
_MUSESCORE_WINDOWS_PATHS = (
    r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
    r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe",
)


def musescore_binary() -> Optional[str]:
    """Locate a MuseScore CLI binary, or return ``None`` when none is found.

    Detection is deliberately independent of music21's stored UserSettings,
    which can hold a stale or malformed path. ``MUSESCORE_BIN`` overrides
    everything when it points at a real file.
    """
    override = os.environ.get("MUSESCORE_BIN")
    if override and Path(override).is_file():
        return override
    for name in _MUSESCORE_NAMES:
        found = shutil.which(name)
        if found:
            return found
    for candidate in _MUSESCORE_WINDOWS_PATHS:
        if Path(candidate).is_file():
            return candidate
    return None


def _musescore_version(binary: str) -> str:
    try:
        proc = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=20
        )
        text = (proc.stdout or proc.stderr or "unknown").strip()
        return text.splitlines()[0][:80] if text else "unknown"
    except (subprocess.TimeoutExpired, OSError):
        return "unknown"


def capabilities() -> dict[str, Any]:
    from .arrangers.guitar_tab import TUNINGS as TAB_TUNINGS
    from .arrangers.score_arrange import STYLES as ARRANGEMENT_STYLES

    musescore = musescore_binary()
    formats = ["midi", "musicxml", "abc", "json", "alphatex"]
    if musescore is not None:
        formats += ["pdf", "svg"]
    return {
        "ok": True,
        "music21": importlib.util.find_spec("music21") is not None,
        "musescore": musescore is not None,
        "musescore_path": musescore,
        "engines": {
            "midi_to_musicxml": "music21",
            "midi_to_tabs": "fretboard-dp",
            "midi_to_arrangement": "music21-arrange",
            "score_to_pdf": "musescore" if musescore else None,
            "future": ["mt3-sidecar", "audiveris-sidecar", "guitarpro-export"],
        },
        "formats": formats,
        "tab_tunings": sorted(TAB_TUNINGS.keys()),
        "arrangement_styles": list(ARRANGEMENT_STYLES),
    }


def register_existing_midis(db: LibraryDB, entry_id: str) -> list[dict[str, Any]]:
    """Mirror legacy ``midis`` rows into ``notation_artifacts``.

    This preserves current MIDI APIs while making the new notation API useful
    immediately for entries that already have MIDI conversions.
    """
    created: list[dict[str, Any]] = []
    for midi in db.list_midis(entry_id):
        midi_id = str(midi.get("id") or "")
        midi_path = str(midi.get("midi_path") or "")
        if not midi_id or not midi_path:
            continue
        artifact_id = f"{midi_id}__artifact_midi"
        db.add_notation_artifact(
            artifact_id=artifact_id,
            entry_id=entry_id,
            kind="midi",
            path=midi_path,
            source_ref=str(midi.get("source_ref") or midi.get("source") or ""),
            engine=str(midi.get("engine") or ""),
            engine_version=str(midi.get("engine_version") or ""),
            metadata={
                "legacy_midi_id": midi_id,
                "notes_count": midi.get("notes_count"),
            },
        )
        created.append(db.get_notation_artifact(artifact_id) or {})
    return created


def convert_score(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Convert a symbolic source (MIDI or MusicXML) to another notation format
    and register the result as a notation artifact.

    ``music21`` handles ``musicxml`` and ``abc`` directly. ``pdf`` and ``svg``
    are engraved by the MuseScore CLI when installed; without it they return
    ``ok=False`` with an install hint. When ``title`` is given it is stamped on
    the score so the rendered sheet shows the originating song's name.
    """
    fmt = fmt.lower().strip()
    if not source_path.is_file():
        return {"ok": False, "error": f"source not found: {source_path}"}
    if fmt in _MUSIC21_FORMATS:
        return _convert_with_music21(
            db,
            entry_id=entry_id,
            source_path=source_path,
            fmt=fmt,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
            title=title,
        )
    if fmt in _MUSESCORE_FORMATS:
        return _convert_with_musescore(
            db,
            entry_id=entry_id,
            source_path=source_path,
            fmt=fmt,
            output_path=output_path,
            source_ref=source_ref,
            artifact_id=artifact_id,
        )
    return {"ok": False, "error": f"unsupported notation format: {fmt!r}"}


def _convert_with_music21(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    title: str = "",
) -> dict[str, Any]:
    try:
        from music21 import converter  # type: ignore[import]
        import music21  # type: ignore[import]
    except ImportError:
        return {
            "ok": False,
            "engine": "music21",
            "error": "music21 is not installed. Install it to enable symbolic export.",
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        score = converter.parse(str(source_path))
        # Quantize raw transcriptions to clean, notatable rhythms. Best-effort.
        try:
            score = score.quantize((4, 3), inPlace=False, recurse=True)
        except Exception as exc:  # noqa: BLE001 - quantize is best-effort
            log.debug("notation: music21 quantize skipped for %s: %s", source_path, exc)
        # Stamp the originating song's name (and the artist as composer) so the
        # engraved sheet is titled + credited — raw MIDI carries neither, which
        # is why untitled sheets showed music21's "Music21 Fragment" placeholder
        # and a "Music21" composer. The composer is ALWAYS overwritten (never
        # left as music21's default); the title drops any media extension.
        clean = clean_title(title)
        composer = artist_name()
        try:
            from music21.metadata import Metadata  # type: ignore[import]

            if score.metadata is None:
                score.insert(0, Metadata())
            # Only the work title (song name); deliberately NOT movementName.
            # music21 writes title -> <work-title> AND movementName ->
            # <movement-title>; OSMD (and MuseScore) render work-title as the
            # Title and movement-title as the Subtitle, so setting both to the
            # song name prints the title twice. The artist is the composer; the
            # viewer places it under the title via the subtitle slot.
            if clean:
                score.metadata.title = clean
            score.metadata.composer = composer
        except Exception as exc:  # noqa: BLE001 - titling is best-effort
            log.debug("notation: could not set title on %s: %s", output_path, exc)
        written = score.write(fmt, fp=str(output_path))
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: %s export failed for %s: %s", fmt, source_path, exc)
        return {"ok": False, "engine": "music21", "error": repr(exc)}

    final_path = Path(written) if written else output_path
    return _register_conversion(
        db,
        entry_id=entry_id,
        fmt=fmt,
        final_path=final_path,
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="music21",
        engine_version=str(getattr(music21, "__version__", "unknown")),
    )


def _convert_with_musescore(
    db: LibraryDB,
    *,
    entry_id: str,
    source_path: Path,
    fmt: str,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
) -> dict[str, Any]:
    binary = musescore_binary()
    if binary is None:
        return {
            "ok": False,
            "engine": "musescore",
            "error": (
                "MuseScore CLI not found. Install MuseScore 4 or set the "
                "MUSESCORE_BIN environment variable to enable PDF/SVG export."
            ),
        }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            [binary, "-o", str(output_path), str(source_path)],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"ok": False, "engine": "musescore", "error": repr(exc)}

    final_path = output_path
    # MuseScore paginates SVG output as ``<stem>-1.svg``; take the first page.
    if fmt == "svg" and not final_path.is_file():
        paged = output_path.with_name(f"{output_path.stem}-1{output_path.suffix}")
        if paged.is_file():
            final_path = paged
    if proc.returncode != 0 or not final_path.is_file():
        detail = (proc.stderr or proc.stdout or "musescore produced no output").strip()
        return {"ok": False, "engine": "musescore", "error": detail[-400:]}

    return _register_conversion(
        db,
        entry_id=entry_id,
        fmt=fmt,
        final_path=final_path,
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="musescore",
        engine_version=_musescore_version(binary),
    )


def _register_conversion(
    db: LibraryDB,
    *,
    entry_id: str,
    fmt: str,
    final_path: Path,
    source_path: Path,
    source_ref: Optional[str],
    artifact_id: Optional[str],
    engine: str,
    engine_version: str,
) -> dict[str, Any]:
    kind = _KIND_FOR_FORMAT.get(fmt, fmt)
    art_id = artifact_id or f"{entry_id}__{final_path.stem}__{kind}"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind=kind,
        path=str(final_path),
        source_ref=source_ref or str(source_path),
        engine=engine,
        engine_version=engine_version,
        metadata={"source": str(source_path), "format": fmt},
    )
    db.add_relation(
        from_id=source_ref or str(source_path),
        to_id=art_id,
        kind="rendered_as_notation",
        metadata={"format": fmt, "engine": engine},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(final_path),
        "engine": engine,
    }


def midi_to_musicxml(
    db: LibraryDB,
    *,
    entry_id: str,
    midi_path: Path,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Convert a MIDI file to MusicXML and register the artifact.

    Retained for backwards compatibility with the original ``from-midi``
    route; it delegates to :func:`convert_score`. New callers should prefer
    ``convert_score`` directly so they can target any supported format.
    """
    if not midi_path.is_file():
        return {"ok": False, "error": f"midi not found: {midi_path}"}
    return convert_score(
        db,
        entry_id=entry_id,
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        title=title,
    )


def midi_to_tabs(
    db: LibraryDB,
    *,
    entry_id: str,
    midi_path: Path,
    output_path: Path,
    instrument: str = "guitar",
    tuning: Optional[list[int]] = None,
    tuning_name: Optional[str] = None,
    capo: int = 0,
    difficulty: str = "medium",
    title: str = "",
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
) -> dict[str, Any]:
    """Arrange a MIDI file into tablature, write alphaTex, and register it as a
    notation artifact of kind ``alphatex``."""
    from .arrangers.guitar_tab import arrange_tabs

    if not midi_path.is_file():
        return {"ok": False, "error": f"midi not found: {midi_path}"}

    result = arrange_tabs(
        midi_path,
        instrument=instrument,
        tuning=tuning,
        tuning_name=tuning_name,
        capo=capo,
        difficulty=difficulty,
        title=title,
    )
    if not result.get("ok"):
        return result

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result["alphatex"], encoding="utf-8")

    art_id = artifact_id or f"{entry_id}__{output_path.stem}__alphatex"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind="alphatex",
        path=str(output_path),
        source_ref=source_ref or str(midi_path),
        engine="fretboard-dp",
        engine_version="1",
        metadata={
            "instrument": result["instrument"],
            "tuning": result["tuning"],
            "tuning_name": result["tuning_name"],
            "capo": result["capo"],
            "difficulty": result["difficulty"],
            "stats": result["stats"],
        },
    )
    db.add_relation(
        from_id=source_ref or str(midi_path),
        to_id=art_id,
        kind="tabbed_as_notation",
        metadata={"format": "alphatex", "instrument": result["instrument"]},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(output_path),
        "stats": result["stats"],
        "tuning_name": result["tuning_name"],
    }


def midi_to_arrangement(
    db: LibraryDB,
    *,
    entry_id: str,
    sources: list[Path],
    style: str,
    output_path: Path,
    source_ref: Optional[str] = None,
    artifact_id: Optional[str] = None,
    title: str = "",
) -> dict[str, Any]:
    """Arrange one or more source MIDIs into a MusicXML score of ``style`` and
    register it as a ``musicxml`` notation artifact."""
    from .arrangers.score_arrange import arrange

    result = arrange(sources, style=style, title=title)
    if not result.get("ok"):
        return result

    try:
        import music21  # type: ignore[import]
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    # Credit the artist as composer on the arrangement too, and re-stamp a
    # cleaned title (the arranger sets it from the song name, which may carry a
    # media extension).
    clean = clean_title(title)
    composer = artist_name()
    try:
        from music21.metadata import Metadata  # type: ignore[import]

        sc = result["score"]
        if sc.metadata is None:
            sc.insert(0, Metadata())
        # Title only (not movementName) so the song name isn't printed twice; see
        # the note in _convert_with_music21. Artist is the composer credit.
        if clean:
            sc.metadata.title = clean
        sc.metadata.composer = composer
    except Exception as exc:  # noqa: BLE001 - crediting is best-effort
        log.debug("notation: could not set composer on arrangement: %s", exc)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        written = result["score"].write("musicxml", fp=str(output_path))
    except Exception as exc:  # noqa: BLE001
        log.warning("notation: arrangement write failed for %s: %s", output_path, exc)
        return {"ok": False, "engine": "music21-arrange", "error": repr(exc)}

    final_path = Path(written) if written else output_path
    art_id = artifact_id or f"{entry_id}__{output_path.stem}__{style}__musicxml"
    db.add_notation_artifact(
        artifact_id=art_id,
        entry_id=entry_id,
        kind="musicxml",
        path=str(final_path),
        source_ref=source_ref or str(sources[0]),
        engine="music21-arrange",
        engine_version=str(getattr(music21, "__version__", "unknown")),
        metadata={
            "style": style,
            "stats": result["stats"],
            "sources": [str(s) for s in sources],
        },
    )
    db.add_relation(
        from_id=source_ref or str(sources[0]),
        to_id=art_id,
        kind="arranged_as_notation",
        metadata={"style": style, "engine": "music21-arrange"},
    )
    return {
        "ok": True,
        "artifact": db.get_notation_artifact(art_id),
        "path": str(final_path),
        "style": style,
        "stats": result["stats"],
    }
