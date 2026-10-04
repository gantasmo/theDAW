"""Routes backing theDAW's SWAY tab.

The tab asks this module one question -- "is there a cockpit to show, and at
what URL?" -- and renders either the iframe or an actionable explanation of
what is missing. Mounted at /api/sway by backend/modules/loader.py.

This module also owns two glue duties the embedded cockpit needs:

* Template media consent. A staged template (``templates/*.sway``), and a
  scene the asset catalog installs (``examples/scenes/*.sway``), names its
  audio by absolute path, and the cockpit fetches that audio through
  ``/api/project/clip-audio`` -- which 403s anything outside the allowed media
  roots. Shipping a template in the bundle IS consent for the files it names
  (the exact model .als import and .tasmo open already use), so the template-
  referenced paths are registered with media_access before the iframe URL is
  handed out. Without this, pressing play on a template yields silence: every
  decode error is swallowed into a warnings array nobody renders.

* Durable saves. The embedded cockpit's ``project.write`` persists to
  localStorage plus a browser download; the staged bundle additionally mirrors
  each save to ``POST /api/sway/project-save`` so a real ``.sway`` file lands
  in ``data/sway-projects`` and survives cleared browser storage.
  ``GET /api/sway/project`` reads one back by name, which is how theDAW opens
  a scene it installed, or by path, for a .sway theDAW saved, installed,
  downloaded or was handed in a dialog anywhere on disk.

* VST renders. The cockpit has no plugin host; a track's VST3 chain is
  rendered once to a wet file (``POST /api/sway/vst-render``) and played under
  the track's wet / dry mix. Each plugin runs in a worker process of its own
  (``backend.modules.vst.isolation``), the output lands in ``data/sway-renders``
  where ``/api/project/clip-audio`` serves it, and the pure parts live in
  ``vst_render.py``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import zipfile
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from backend.modules.assets import catalog
from backend.modules.project import media_access
from backend.modules.vst import path_policy
from backend.modules.vst.isolation import (
    PluginProcessError,
    plugin_label,
    process_with_plugin,
)

from . import sidecar, vst_render
from backend.lib import known_paths, paths
from backend.lib.atomic import atomic_write
from backend.lib.audio_io import load_audio_array, save_audio
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)

log = logging.getLogger(__name__)
router = APIRouter()

_PROJECTS_DIR = paths.data_path("sway-projects")

#: A shipped song read out of its example project (``examples/projects/*.tasmo``)
#: for an install that has no ``examples/audio`` folder, which is kept out of git.
_SONG_CACHE_DIR = paths.data_path("sway-songs")

_template_media_registered = False


def _collect_media_paths(node: object, out: list[str]) -> None:
    """Walk a .sway document for absolute ``"path"`` values (media refs)."""
    if isinstance(node, dict):
        for key, value in node.items():
            if (
                key == "path"
                and isinstance(value, str)
                and (re.match(r"^[A-Za-z]:[\\/]", value) or value.startswith("/"))
            ):
                out.append(value)
            else:
                _collect_media_paths(value, out)
    elif isinstance(node, list):
        for value in node:
            _collect_media_paths(value, out)


def _shipped_song(template: Path) -> Path | None:
    """The copy of a template's song that theDAW ships, matched by name: the
    template ``will-i-dream.sway`` pairs with ``examples/audio/will i dream.*``,
    else with the one song inside ``examples/projects/will i dream.tasmo``."""
    want = template.stem.replace("-", " ").replace("_", " ").casefold()
    try:
        for f in sorted((catalog.EXAMPLES_DIR / "audio").iterdir()):
            if f.is_file() and f.stem.casefold() == want:
                return f
    except OSError:
        pass
    return _song_from_example_project(want)


def _song_from_example_project(want: str) -> Path | None:
    """The one song embedded in the example project named ``want``, read out
    once into data/sway-songs; None when there is no such project, it holds no
    song or several, or it cannot be read."""
    try:
        projects = sorted((catalog.EXAMPLES_DIR / "projects").glob("*.tasmo"))
    except OSError:
        return None
    for project in projects:
        if project.stem.casefold() != want:
            continue
        try:
            with zipfile.ZipFile(project) as zf:
                songs = [
                    n
                    for n in zf.namelist()
                    if n.startswith("audio/") and not n.endswith("/")
                ]
                if len(songs) != 1:
                    return None
                # The bare file name: a member name never picks the folder.
                target = _SONG_CACHE_DIR / Path(songs[0]).name
                size = zf.getinfo(songs[0]).file_size
                if target.is_file() and target.stat().st_size == size:
                    return target
                data = zf.read(songs[0])
            atomic_write(target, data)
            log.info("sway: read %s out of %s", target.name, project.name)
            return target
        except (OSError, zipfile.BadZipFile, KeyError) as e:
            log.warning("sway: no song from %s: %s", project.name, e)
            return None
    return None


def _stand_in_missing_song(template: Path, doc: object) -> None:
    """Point a template's one song at theDAW's shipped copy when the path the
    template names has no file on this machine. The templates are authored on
    another computer, so without this the cockpit's audio lane stays silent."""
    project = doc.get("project") if isinstance(doc, dict) else None
    media = project.get("media") if isinstance(project, dict) else None
    if not isinstance(media, list):
        return
    named = [
        m["path"]
        for m in media
        if isinstance(m, dict) and isinstance(m.get("path"), str) and m["path"]
    ]
    if len(named) != 1 or Path(named[0]).is_file():
        return
    song = _shipped_song(template)
    if song is not None:
        media_access.register_stand_in(named[0], song)


def _register_template_media() -> None:
    """Allowlist every staged template's media with media_access (once)."""
    global _template_media_registered
    if _template_media_registered:
        return
    dist = sidecar.resolve_dist_dir()
    if dist is None:
        return
    paths: list[str] = []
    try:
        for f in sorted((dist / "templates").glob("*.sway")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            _collect_media_paths(doc, paths)
            _stand_in_missing_song(f, doc)
    except OSError:
        return
    # The scenes theDAW's own catalog installs are shipped the same way, and an
    # installed copy in data/sway-projects names the same paths, so the cockpit
    # plays their songs too. Only files in the install's examples folder: a
    # catalog a user dropped into data/assets grants nothing.
    examples = catalog.EXAMPLES_DIR.resolve()
    for entry in catalog.load_entries():
        if entry.format != ".sway":
            continue
        try:
            if not entry.file.resolve().is_relative_to(examples):
                continue
            doc = json.loads(entry.file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        _collect_media_paths(doc, paths)
        _stand_in_missing_song(entry.file, doc)
    # Only the STAGED templates and the catalog's scenes are trusted here. Saved projects under
    # _PROJECTS_DIR are written from a /project-save request body, so reading
    # them back to widen the allowlist would let a request grant itself access
    # to any folder — and would re-grant it on every /status after a restart.
    # media_access's contract is explicit: "Nothing a request body says can
    # widen the allowlist on its own; only a project the server actually
    # parsed can." A cockpit save names media the user already opened, which
    # is therefore already allowlisted, so nothing legitimate needs this.
    if paths:
        media_access.register_paths(paths)
        log.info("sway: registered %d template media path(s)", len(paths))
    _template_media_registered = True


@router.get("/status")
async def sway_status() -> dict:
    """Whether an embedded SwayCommand build is staged and mounted."""
    _register_template_media()
    return sidecar.status()


@router.get("/url")
async def sway_url() -> dict:
    """The URL for the SWAY tab's iframe, or a reason there is none.

    The URL is RELATIVE on purpose. An absolute http://localhost:8600/... works
    in the packaged desktop app and breaks everywhere else (Docker, a phone on
    the LAN, any reverse proxy). Relative also keeps the iframe same-origin
    with theDAW, which is load-bearing: a cross-origin hidden iframe is
    throttled to zero rAF callbacks by Chromium, which would freeze
    SwayCommand's transport clock the moment the user switched tabs.

    The trailing slash is required. Without it the document base becomes "/"
    and the cockpit's relative asset loads (its AudioWorklet in particular)
    resolve against theDAW's root and 404.
    """
    if not sidecar.static_mount_active():
        return {
            "url": None,
            "mode": "unavailable",
            # No commands in user-facing copy. Staging a cockpit build has no
            # API behind it, so this states the fact and stops — an instruction
            # to go and run something is not a fix theDAW can offer.
            "detail": (
                "The SwayCommand cockpit build is not staged in this install, "
                "so there is nothing for the SWAY tab to show yet."
            ),
            "status": sidecar.status(),
        }
    _register_template_media()
    return {
        "url": f"{sidecar.STATIC_MOUNT_PATH}/",
        "mode": "static",
        "detail": None,
        "build": sidecar.read_build_stamp(),
    }


class SwayProjectSave(BaseModel):
    name: str
    doc: dict


def _project_file(name: str, fallback: str | None) -> Path:
    """The .sway file ``name`` names inside data/sway-projects.

    Everything but word characters, spaces, hyphens and dots is dropped, so a
    name carries no separator. A name that sanitizes to nothing becomes
    ``fallback``, or is refused when there is none. The resolved file must sit
    directly in the projects folder, which also refuses a Windows device name.
    """
    safe = re.sub(r"[^\w \-.]+", "", name).strip().strip(".")
    if not safe:
        if fallback is None:
            raise HTTPException(400, f"Invalid project name: {name}")
        safe = fallback
    if not safe.lower().endswith(".sway"):
        safe += ".sway"
    root = _PROJECTS_DIR.resolve()
    target = (root / safe).resolve()
    if target.parent != root:
        raise HTTPException(400, f"Invalid project name: {name}")
    return target


def _listed_scene(name: str) -> Path | None:
    """The .sway file in data/sway-projects whose stem is exactly ``name``.

    Only names of files already in the folder can match, so nothing in
    ``name`` can point outside it."""
    stem = name[: -len(".sway")] if name.lower().endswith(".sway") else name
    if not stem or not _PROJECTS_DIR.is_dir():
        return None
    for p in _PROJECTS_DIR.glob("*.sway"):
        if p.stem == stem and p.is_file():
            return p.resolve()
    return None


@router.post("/project-save")
async def sway_project_save(req: SwayProjectSave) -> dict:
    """Persist a cockpit save as a real .sway file under data/sway-projects."""
    _PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    target = _project_file(req.name, fallback="untitled")
    try:
        # Atomic, because GET /project may read this file while a save lands.
        atomic_write(target, json.dumps(req.doc, indent=2))
    except OSError as e:
        raise HTTPException(500, f"Save failed: {e}")
    # The scene folder is theDAW's own, so a save leaves the .sway picker's
    # folder where the user last chose a file.
    known_paths.record(target, kind="sway", source="sway-save", update_folder=False)
    # Deliberately does NOT call media_access.register_paths(req.doc's media).
    # The server binds 0.0.0.0 with permissive CORS, so this body is
    # attacker-reachable; registering paths from it would turn a save into
    # "allowlist any folder on disk", and /clip-audio would then serve the
    # audio under it. The media a real cockpit save names was already
    # allowlisted when the user opened the project, so playback is unaffected.
    # If a path genuinely is not reachable, add it as a media root instead.
    return {"status": "ok", "path": str(target)}


_SCENE_NOT_SERVED = "That scene file is gone or was never opened in theDAW."


def _servable_scene(path: str) -> dict:
    """The .sway at ``path``, when known_paths may serve it.

    One 403 for a path never recorded, recorded but not servable, gone, or not
    a .sway, so the answer reveals nothing about the filesystem."""
    served = known_paths.find_servable(path)
    if served is None or not served.lower().endswith(".sway"):
        raise HTTPException(403, _SCENE_NOT_SERVED)
    target = Path(served)
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(403, _SCENE_NOT_SERVED) from e
    try:
        doc = json.loads(text)
    except ValueError as e:
        raise HTTPException(500, f"Could not read {target.name}: {e}") from e
    return {"name": target.stem, "path": served, "doc": doc}


@router.get("/project", dependencies=[Depends(refuse_cross_site)])
def sway_project(
    name: str | None = Query(
        None, description="the scene's file stem, as /projects lists"
    ),
    path: str | None = Query(
        None,
        description="a .sway theDAW saved, installed, downloaded or was handed "
        "in a dialog",
    ),
) -> dict:
    """One .sway scene, read back so theDAW can hand it to the cockpit.

    By ``path``: only a file known_paths may serve, else 403. By ``name``: a
    scene in data/sway-projects; 404 when no scene has that name, 400 when the
    name is not one. A name /projects lists is matched exactly first, so a file
    whose name holds characters a save would drop (an install's
    "Scene (2).sway") still opens."""
    if path is not None:
        return _servable_scene(path)
    if name is None:
        raise HTTPException(422, "Name a scene or give its path.")
    target = _listed_scene(name) or _project_file(name, fallback=None)
    if not target.is_file():
        raise HTTPException(404, f"No saved scene named {name}")
    try:
        doc = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"Could not read {target.name}: {e}")
    return {"name": target.stem, "path": str(target), "doc": doc}


_DIGESTS: dict[tuple[str, int, int], str] = {}
_DIGESTS_MAX = 256


def _digest(path: Path, st: os.stat_result) -> str:
    """sha256 of ``path``, cached by path, mtime and size."""
    key = (str(path), st.st_mtime_ns, st.st_size)
    cached = _DIGESTS.get(key)
    if cached is not None:
        return cached
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    if len(_DIGESTS) >= _DIGESTS_MAX:
        _DIGESTS.clear()
    _DIGESTS[key] = h.hexdigest()
    return _DIGESTS[key]


def _catalog_scene_digests() -> dict[int, set[str]]:
    """Size -> digests of every .sway file the asset catalog installs."""
    out: dict[int, set[str]] = {}
    for entry in catalog.load_entries():
        if entry.format != ".sway":
            continue
        try:
            st = entry.file.stat()
            out.setdefault(st.st_size, set()).add(_digest(entry.file, st))
        except OSError:
            continue
    return out


@router.get("/projects")
async def sway_projects() -> dict:
    """List the .sway projects in data/sway-projects, newest first.

    ``builtin`` is true for a file whose bytes match a .sway the asset catalog
    installs, so a numbered second install counts too. A cockpit save over an
    installed scene rewrites the file, and from then on it is the user's own."""
    if not _PROJECTS_DIR.is_dir():
        return {"projects": []}
    shipped = _catalog_scene_digests()
    rows: list[dict] = []
    for p in _PROJECTS_DIR.glob("*.sway"):
        try:
            st = p.stat()
        except OSError:
            continue
        builtin = False
        if st.st_size in shipped:
            try:
                builtin = _digest(p, st) in shipped[st.st_size]
            except OSError:
                builtin = False
        rows.append(
            {"name": p.stem, "path": str(p), "mtime": st.st_mtime, "builtin": builtin}
        )
    # Newest first; scenes written in one tick of the file clock (15.6 ms on
    # Windows, a whole install at once) list by name, not in whatever order
    # the folder happened to be read.
    rows.sort(key=lambda r: r["name"].casefold())
    rows.sort(key=lambda r: r["mtime"], reverse=True)
    return {"projects": rows}


# ---------------------------------------------------------------------------
# The cockpit's track VST chain, rendered here
# ---------------------------------------------------------------------------

#: One answer for an input never recorded, outside every media root, gone, or
#: a browser-only path, so the refusal reveals nothing about the filesystem.
_INPUT_NOT_SERVED = "That audio is not a file theDAW may render."


class SwayVstPlugin(BaseModel):
    path: str
    #: Normalized 0..1 positions keyed by pedalboard's parameter name: the
    #: cockpit's track panel is a row of 0..1 sliders and stores them so.
    params: dict[str, float] | None = None
    #: The base64 state its plugin window captured, applied before ``params``.
    rawState: str | None = None


class SwayVstRenderRequest(BaseModel):
    #: An absolute path from a scene, or a URL theDAW handed the cockpit
    #: (``/api/library/audio/<id>``, a stem, ``/api/project/clip-audio``).
    input: str
    plugins: list[SwayVstPlugin]
    #: Seconds of silence appended for the chain's decay.
    tail: float = vst_render.DEFAULT_TAIL_SECONDS


def _library_audio_path(entry_id: str) -> Path | None:
    """The file behind ``/api/library/audio/<id>``, or None."""
    from backend.modules.library.router import get_store

    try:
        store = get_store()
        if store.get_entry(entry_id) is None:
            return None
        return store.get_audio_path(entry_id)
    except Exception as e:  # noqa: BLE001 -- a library still opening refuses
        log.info("sway: library lookup for %r failed: %s", entry_id, e)
        return None


def _stem_audio_path(stem_id: str) -> Path | None:
    """The file behind ``/api/library/stems/<id>/audio``, or None."""
    from backend.modules.library.router import get_store

    try:
        store = get_store()
        stem = store.db.get_stem(stem_id) if store.db is not None else None
    except Exception as e:  # noqa: BLE001 -- a library still opening refuses
        log.info("sway: stem lookup for %r failed: %s", stem_id, e)
        return None
    if not stem or not stem.get("audio_path"):
        return None
    return Path(stem["audio_path"])


def _plugin_path(raw: str) -> Path:
    """A cockpit-supplied plugin path, policed as the /api/vst routes police
    theirs (``path_policy``: a real ``.vst3`` inside an allowed root)."""
    try:
        return path_policy.check_plugin_path(raw)
    except path_policy.PluginPathError as e:
        raise HTTPException(status_code=e.status, detail=e.message) from e


def _wav_seconds(path: Path) -> tuple[float, int] | None:
    """(seconds, sample rate) from the file's header when libsndfile reads
    it; None for a format it cannot open, which the decoder then measures."""
    try:
        import soundfile as sf

        info = sf.info(str(path))
    except Exception:  # noqa: BLE001 -- any unreadable header means "measure later"
        return None
    if not info.samplerate:
        return None
    return float(info.frames) / float(info.samplerate), int(info.samplerate)


def _rendered(out: Path, cached: bool, warnings: list[str]) -> dict:
    length = _wav_seconds(out)
    if length is None:
        raise HTTPException(500, f"The render at {out.name} could not be read back.")
    seconds, sample_rate = length
    return {
        "ok": True,
        "output": str(out),
        "seconds": seconds,
        "sampleRate": sample_rate,
        "cached": cached,
        "warnings": warnings,
    }


@router.post("/vst-render")
def sway_vst_render(req: SwayVstRenderRequest, request: Request) -> dict:
    """Render a clip through the cockpit's track VST chain to a float WAV.

    The input is read with ``backend.lib.audio_io``, ``tail`` seconds of
    silence are appended, each plugin runs in order in a worker process of its
    own (a crash is a 502 naming the plugin), the result is clipped to -1..1
    and written to ``data/sway-renders/<key>.wav``, where ``key`` hashes the
    input's path, mtime and size with the chain and the tail, so an unchanged
    chain reuses its render. The file is recorded with known_paths and lies
    in a clip-audio root, so the cockpit fetches it like any scene media.

    Gated as the VST render routes are: it runs plugin code against a file
    the caller names. The input must be a file known_paths may serve or one
    inside theDAW's media roots (the clip-audio rule); anything else is one
    403. Each plugin path passes the VST module's path policy.
    """
    require_loopback_launch_or_pairing_token(request)
    if not req.plugins:
        raise HTTPException(422, "The track has no plugins to render through.")
    if (
        not math.isfinite(req.tail)
        or req.tail < 0
        or req.tail > vst_render.MAX_TAIL_SECONDS
    ):
        raise HTTPException(
            422, f"tail must be between 0 and {vst_render.MAX_TAIL_SECONDS:g} seconds."
        )
    chain = [
        {
            "path": str(_plugin_path(p.path)),
            "params": p.params or {},
            "rawState": p.rawState or None,
        }
        for p in req.plugins
    ]
    src = vst_render.resolve_input(
        req.input, library_audio=_library_audio_path, stem_audio=_stem_audio_path
    )
    if src is None:
        raise HTTPException(403, _INPUT_NOT_SERVED)
    try:
        st = src.stat()
    except OSError as e:
        raise HTTPException(403, _INPUT_NOT_SERVED) from e
    too_long = f"{src.name} is longer than an hour, the most a render takes."
    header = _wav_seconds(src)
    if header is not None and header[0] > vst_render.MAX_INPUT_SECONDS:
        raise HTTPException(422, too_long)

    key = vst_render.render_key(src, st.st_mtime_ns, st.st_size, chain, req.tail)
    out = vst_render.renders_dir() / f"{key}.wav"
    if out.is_file():
        return _rendered(out, cached=True, warnings=[])

    try:
        channels_first, sample_rate = load_audio_array(src)
    except Exception as e:  # noqa: BLE001 -- the decoder's reason is the answer
        raise HTTPException(400, f"{src.name} could not be decoded: {e}") from e
    audio = np.ascontiguousarray(channels_first.T, dtype=np.float32)
    if audio.shape[0] / float(sample_rate) > vst_render.MAX_INPUT_SECONDS:
        raise HTTPException(422, too_long)
    audio = vst_render.with_tail(audio, sample_rate, req.tail)

    warnings: list[str] = []
    for entry in chain:
        name = plugin_label(entry["path"])
        notes: list[str] = []
        try:
            processed = process_with_plugin(
                entry["path"],
                audio,
                sample_rate,
                raw_params=entry["params"] or None,
                raw_state=entry["rawState"],
                warnings=notes,
            )
        except PluginProcessError as e:
            raise HTTPException(e.status_code, str(e)) from e
        except FileNotFoundError as e:
            raise HTTPException(404, str(e)) from e
        except Exception as e:  # noqa: BLE001 -- the plugin's reason, named
            raise HTTPException(500, f"{name} failed to render: {e}") from e
        warnings.extend(f"{name}: {note}" for note in notes)
        audio = np.asarray(processed, dtype=np.float32)
        if audio.ndim == 1:
            audio = audio[:, np.newaxis]
    audio = np.clip(audio, -1.0, 1.0)

    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(f"{out.stem}.{os.getpid()}.part.wav")
    try:
        # save_audio takes (channels, frames); audio is (frames, channels).
        save_audio(part, audio.T, sample_rate, format="wav", subtype="FLOAT")
        os.replace(part, out)
    except OSError as e:
        part.unlink(missing_ok=True)
        raise HTTPException(500, f"The render could not be written: {e}") from e
    # Recorded as a file the app wrote; pickers keep the user's own folder.
    known_paths.record(out, kind="audio", source="sway-render", update_folder=False)
    return _rendered(out, cached=False, warnings=warnings)
