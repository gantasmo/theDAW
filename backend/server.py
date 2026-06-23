from __future__ import annotations

import asyncio
import sys
import threading

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import base64
import io
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from collections import OrderedDict
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

import numpy as np
from fastapi import Body, FastAPI, Form, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from backend.admin_routes import router as admin_router
from backend.assistant_routes import router as assistant_router
from backend.modules.loader import load_modules

# Heavy imports (torch, torchaudio, matplotlib, and the stable_audio_3 model
# graph) total ~9.6s and are deliberately kept OFF module scope so uvicorn binds
# :8600 in ~1s instead of after the whole torch/XLA stack loads. Each is imported
# lazily inside the functions that use it (cheap once cached) and warmed in a
# background thread by the startup event (`_warm_heavy`). TYPE_CHECKING keeps the
# annotations resolvable for type checkers at zero runtime cost.
if TYPE_CHECKING:
    import torch
    from matplotlib.figure import Figure

logger = logging.getLogger(__name__)

app = FastAPI(title="theDAW API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline: Any = None
sample_rate = 44100
PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULES_DIR = Path(__file__).parent / "modules"

app.state.loaded_modules = load_modules(app, MODULES_DIR)
DEFAULT_GENERATION_MODEL = "medium"
_GENERATION_MODELS_CACHE: dict[str, Any] | None = None
SPECTROGRAM_TYPES = ("mel", "stft", "chromagram", "cqt")
_UNSAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._ -]+")
_DASH_RUN = re.compile(r"-{2,}")
_WINDOWS_RESERVED_FILENAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_generation_pipelines: dict[str, Any] = {}
_active_model_name = DEFAULT_GENERATION_MODEL
# True while the SA3 model(s) are parked in CPU RAM (VRAM freed for a co-resident
# GPU workload such as the Magenta RT2 sidecar). Swapped back by /api/model/onload.
_sa3_offloaded = False
_generation_job_lock = asyncio.Lock()
# Serializes EVERY model device transition (load / park / wake / offload / onload)
# across the event loop and executor threads, so one transition can never move
# weights out from under another. Reentrant because the wake path parks the
# previous resident inside the same transition.
_model_move_lock = threading.RLock()

# Spectrogram cache: {job_id: {mel, stft, chromagram, cqt}}
_spec_cache: OrderedDict[str, dict[str, str]] = OrderedDict()
_SPEC_CACHE_MAX_SIZE = 20


def _add_to_spec_cache(key: str, value: dict[str, str]):
    _spec_cache[key] = value
    if len(_spec_cache) > _SPEC_CACHE_MAX_SIZE:
        _spec_cache.popitem(last=False)


def _generation_models() -> dict[str, Any]:
    """Lazy ``{**arc_models, **rf_models}``. Importing ``model_configs`` pulls the
    stable_audio_3 package ``__init__`` (the full model graph, ~4s), so it is
    deferred off the startup path and cached after the first call."""
    global _GENERATION_MODELS_CACHE
    if _GENERATION_MODELS_CACHE is None:
        from stable_audio_3.model_configs import arc_models, rf_models

        _GENERATION_MODELS_CACHE = {**arc_models, **rf_models}
    return _GENERATION_MODELS_CACHE


class _LazyGenerationModels(Mapping[str, Any]):
    def __getitem__(self, key: str) -> Any:
        return _generation_models()[key]

    def __iter__(self) -> Iterator[str]:
        return iter(_generation_models())

    def __len__(self) -> int:
        return len(_generation_models())


GENERATION_MODELS: Mapping[str, Any] = _LazyGenerationModels()


def _warm_heavy() -> None:
    """Pre-import the heavy stack (torch, torchaudio, the stable_audio_3 model
    graph) so the first generation is not cold. Runs in a background thread from
    the startup event AFTER uvicorn has bound the port, so it never delays
    server-ready. Each import here is the one that pays the cost; the lazy
    ``import torch`` calls scattered through the request handlers are then instant
    (already in ``sys.modules``)."""
    try:
        import platform

        import torch
        import torch.version  # submodule; explicit so type checkers resolve .cuda
        import torchaudio  # noqa: F401

        gpu_info = "no CUDA"
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            gpu_info = (
                f"{props.name} "
                f"({round(props.total_memory / 1024**3, 1)} GB VRAM, "
                f"cuda={torch.version.cuda})"
            )
        logger.info(
            "startup: torch=%s (python=%s) gpu=%s",
            torch.__version__,
            platform.python_version(),
            gpu_info,
        )

        _generation_models()
        from stable_audio_3.inference import distribution_shift  # noqa: F401

        logger.info("startup: heavy imports warmed (torch + stable_audio_3 ready)")
    except Exception as e:  # noqa: BLE001 — warming is best-effort
        logger.warning("startup: heavy-import warm failed: %s", e)


@dataclass(frozen=True)
class LoraFormSlot:
    index: int
    upload: Any
    weight: float


def _registered_local_models() -> list[str]:
    """Ids of user-registered local checkpoints that currently resolve."""
    try:
        from backend.modules.storage.store import get_registry

        return sorted(
            e["id"] for e in get_registry().list_checkpoints() if e.get("resolves")
        )
    except Exception:
        return []


def _normalize_generation_model(model_name: str | None) -> str:
    """Return a supported DiT generation model, falling back away from AE-only names."""
    normalized = (model_name or "").strip().lower()
    if normalized in _generation_models():
        return normalized
    if normalized.startswith("local:"):
        # User-registered local checkpoint (Models & Storage). Honor it only
        # while the registry entry still resolves to real files.
        from backend.modules.storage.store import get_registry

        if get_registry().get_path(normalized):
            return normalized
    return DEFAULT_GENERATION_MODEL


# Parking a ~4 GB fp16 pipeline into RAM needs real headroom; below this much
# free physical RAM we evict instead so the OS and other subsystems never starve.
_PARK_MIN_FREE_RAM_GB = 10.0


def _park_or_evict_other_generation_pipelines(keep: str) -> None:
    """Single GPU resident model; others go ON ICE in CPU RAM for fast swaps.

    When the user switches models, the previous pipeline is moved to CPU RAM
    (bit-identical, swaps back in seconds — no disk reload) when free RAM
    allows; otherwise it is evicted entirely.
    """
    import torch

    global pipeline
    others = [k for k in list(_generation_pipelines) if k != keep]
    if not others:
        return
    free_gb = None
    try:
        import psutil

        free_gb = psutil.virtual_memory().available / 1024**3
    except Exception:
        free_gb = None

    for k in others:
        pl = _generation_pipelines[k]
        already_parked = str(getattr(pl, "device", "")) == "cpu"
        if already_parked:
            continue
        if free_gb is not None and free_gb >= _PARK_MIN_FREE_RAM_GB:
            try:
                pl.model.to("cpu")
                pl.device = torch.device("cpu")
                logger.info(
                    "model.park: %r on ice in CPU RAM (free %.1f GB)", k, free_gb
                )
                continue
            except Exception as e:
                logger.warning("model.park: %r failed (%s) — evicting", k, e)
        _generation_pipelines.pop(k, None)
        if pipeline is pl:
            pipeline = None
        del pl
        logger.info(
            "model.evict: unloaded %r (free RAM %s)",
            k,
            f"{free_gb:.1f} GB" if free_gb is not None else "unknown",
        )

    import gc

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _ensure_gpu_clear_of_magenta() -> None:
    """Stop any resident MRT2 engine before an SA3 load/wake (blocking).

    The dropdown swap covers the UI flow; this covers every other path that
    reaches an SA3 generation (assistant actions, API callers, capture
    harnesses driving the store directly). A resident engine holds GPU memory
    AND several GB of host commit through the WSL2 VM, and stacking the SA3
    checkpoint load on top is exactly the combination that exhausts the
    Windows commit limit (os error 1455 -> access-violation crash).
    """
    try:
        import socket

        from backend.modules.magenta import sidecar as magenta_sidecar

        listening = magenta_sidecar.engine_process_alive()
        if not listening:
            # Engines started outside this process (the .vbs launcher, a
            # manual run): probe the two known ports cheaply.
            for port in (8777, 8778):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                        listening = True
                        break
                except OSError:
                    continue
        if listening:
            logger.info("model.swap: stopping resident MRT2 engine before SA3 load")
            magenta_sidecar.stop_engine()
    except Exception:
        logger.debug("model.swap: magenta engine pre-clear failed", exc_info=True)


def _get_or_load_generation_pipeline(model_name: str):
    """Load and cache the selected DiT generation pipeline."""
    import torch

    global pipeline, sample_rate, _active_model_name, _sa3_offloaded

    normalized = _normalize_generation_model(model_name)
    with _model_move_lock:
        if normalized not in _generation_pipelines:
            from stable_audio_3.model import StableAudioModel

            load_target = normalized
            if normalized.startswith("local:"):
                from backend.modules.storage.store import get_registry

                load_target = get_registry().get_path(normalized)
                if not load_target:
                    raise HTTPException(
                        404,
                        f"Local checkpoint {normalized!r} is no longer registered. "
                        "Re-add it under Settings → Models & Storage.",
                    )
            _park_or_evict_other_generation_pipelines(normalized)
            logger.info(
                "model.load: starting from_pretrained for %r (%s)",
                normalized,
                load_target,
            )
            t0 = time.perf_counter()
            _generation_pipelines[normalized] = StableAudioModel.from_pretrained(
                load_target
            )
            dt = time.perf_counter() - t0
            logger.info(
                "model.load: %r ready in %.2fs (cuda=%s)",
                normalized,
                dt,
                torch.cuda.is_available(),
            )
            if torch.cuda.is_available():
                mem_gb = torch.cuda.memory_allocated() / 1024**3
                logger.info("model.load: %r VRAM allocated %.2f GB", normalized, mem_gb)

        selected = _generation_pipelines[normalized]
        # wake a parked (on-ice) pipeline back onto the GPU, parking the previous
        # resident first so only one big model holds VRAM at a time
        if torch.cuda.is_available() and str(getattr(selected, "device", "")) == "cpu":
            _park_or_evict_other_generation_pipelines(normalized)
            t0 = time.perf_counter()
            selected.model.to("cuda")
            selected.device = torch.device("cuda")
            logger.info(
                "model.wake: %r CPU→CUDA in %.2fs", normalized, time.perf_counter() - t0
            )
        if _sa3_offloaded and str(getattr(selected, "device", "")) != "cpu":
            # The model is resident again, so the parked-for-sidecar state no longer
            # holds; keep /api/model/offload-status truthful.
            _sa3_offloaded = False
            logger.info("model.wake: cleared sa3-offloaded flag (VRAM reclaimed)")
        pipeline = selected
        sample_rate = selected.model_config["sample_rate"]
        _active_model_name = normalized
        return selected


def _coerce_form_bool(value) -> bool:
    """Coerce browser FormData boolean strings into Python booleans."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _normalize_init_audio_type(init_audio_type: str | None) -> str:
    normalized = (init_audio_type or "Audio").strip().lower()
    if normalized in {"rf-inv", "rf inversion", "rf-inversion", "rfinversion"}:
        return "RF-Inversion"
    return "Audio"


def _validate_init_audio_mode(init_audio_type: str | None, has_init_audio: bool) -> str:
    normalized = _normalize_init_audio_type(init_audio_type)
    if has_init_audio and normalized == "RF-Inversion":
        raise HTTPException(
            status_code=501,
            detail=(
                "RF-Inversion controls are present in the UI, but the current "
                "Stable Audio 3 pipeline code does not implement RF-Inversion yet. "
                "Use Init Audio / Audio mode for this generation."
            ),
        )
    return normalized


def _condense_filename_text(text: str | None, fallback: str = "_") -> str:
    condensed = _UNSAFE_FILENAME_CHARS.sub("-", str(text or ""))
    condensed = _DASH_RUN.sub("-", condensed).strip(" .-")[:150].rstrip(" .-")
    if not condensed:
        condensed = fallback
    if condensed.upper() in _WINDOWS_RESERVED_FILENAMES:
        condensed = f"{condensed}_"
    return condensed


def _get_generation_artifacts_root() -> Path:
    """Return the local folder where generated audio + spectrograms are saved."""
    configured = os.getenv("theDAW_GENERATIONS_DIR")
    return (
        Path(configured).expanduser().resolve()
        if configured
        else PROJECT_ROOT / "data" / "generations"
    )


def _safe_filename(filename: str | None, fallback: str = "output.wav") -> str:
    raw_name = str(filename or fallback).replace("\\", "-").replace("/", "-")
    fallback_suffix = Path(fallback).suffix or ".wav"
    suffix_match = re.search(r"\.[A-Za-z0-9]{1,16}$", raw_name)
    suffix = suffix_match.group(0) if suffix_match else fallback_suffix
    stem_text = (
        raw_name[: -len(suffix)] if suffix and raw_name.endswith(suffix) else raw_name
    )
    stem = _condense_filename_text(stem_text, Path(fallback).stem or "output")
    suffix = _UNSAFE_FILENAME_CHARS.sub("", suffix or fallback_suffix)
    if suffix.lower() not in {".wav", ".flac", ".ogg", ".png", ".json", ".safetensors"}:
        suffix = fallback_suffix
    return f"{stem}{suffix}"


def _make_generation_filename(
    job_id: str,
    index: int,
    file_format: str,
    file_naming: str,
    prompt: str,
    negative_prompt: str | None,
    seed: int,
    custom_name: str | None = None,
) -> str:
    """Build a safe output filename using the frontend-selected naming mode.

    A non-empty ``custom_name`` (the UI "NAME" field) overrides the naming mode.
    """
    fmt = (file_format or "wav").split()[0].lower()
    if fmt not in {"wav", "flac", "ogg"}:
        fmt = "wav"

    if custom_name and custom_name.strip():
        return f"{_condense_filename_text(custom_name)}_{index}.{fmt}"

    mode = (file_naming or "verbose").strip().lower()
    if mode == "seed":
        basename = f"seed_{seed}"
    elif mode == "prompt":
        basename = _condense_filename_text(prompt)
    elif mode == "verbose":
        basename = _condense_filename_text(prompt)
        if negative_prompt:
            basename += f".neg-{_condense_filename_text(negative_prompt)}"
        basename += f".{seed}"
    else:
        basename = f"thedaw_{_condense_filename_text(job_id[:8], 'job')}"

    return f"{basename}_{index}.{fmt}"


def _save_generation_artifacts_sync(
    job_id: str,
    index: int,
    audio_bytes: bytes,
    audio_filename: str,
    mime_type: str,
    spectrograms: dict[str, str],
    metadata: dict | None = None,
) -> dict:
    """Save one generation's audio, spectrogram PNGs, and metadata locally (blocking)."""
    item_dir = _get_generation_artifacts_root() / job_id / f"{index:02d}"
    item_dir.mkdir(parents=True, exist_ok=True)

    safe_audio_filename = _safe_filename(audio_filename)
    audio_path = item_dir / safe_audio_filename
    audio_path.write_bytes(audio_bytes)

    spectrogram_paths: dict[str, str | None] = {}
    for name in SPECTROGRAM_TYPES:
        encoded = spectrograms.get(name) or ""
        if not encoded:
            spectrogram_paths[name] = None
            continue
        spec_path = item_dir / f"spectrogram_{name}.png"
        spec_path.write_bytes(base64.b64decode(encoded))
        spectrogram_paths[name] = str(spec_path)

    metadata_path = item_dir / "metadata.json"
    metadata_payload = {
        "job_id": job_id,
        "index": index,
        "filename": safe_audio_filename,
        "mime_type": mime_type,
        "audio_path": str(audio_path),
        "artifact_dir": str(item_dir),
        "spectrogram_paths": spectrogram_paths,
        "saved_at": time.time(),
        **(metadata or {}),
    }
    metadata_path.write_text(json.dumps(metadata_payload, indent=2), encoding="utf-8")

    return {
        "artifact_dir": str(item_dir),
        "audio_path": str(audio_path),
        "spectrogram_paths": spectrogram_paths,
        "metadata_path": str(metadata_path),
    }


def _extract_lora_form_slots(form) -> list[LoraFormSlot]:
    """Extract ordered LoRA uploads and weights from multipart form data."""
    slots: list[LoraFormSlot] = []
    for key, upload in form.multi_items():
        if not key.startswith("lora_file_"):
            continue
        try:
            index = int(key.rsplit("_", 1)[1])
        except (IndexError, ValueError):
            continue
        if not getattr(upload, "filename", None):
            continue
        try:
            weight = float(form.get(f"lora_weight_{index}", 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        slots.append(LoraFormSlot(index=index, upload=upload, weight=weight))
    return sorted(slots, key=lambda slot: slot.index)


async def _persist_lora_uploads(
    form, job_id: str
) -> tuple[list[str], list[float], Path | None]:
    """Persist uploaded LoRA files long enough for the background job to load them."""
    slots = _extract_lora_form_slots(form)
    if not slots:
        return [], [], None

    temp_dir = Path(tempfile.mkdtemp(prefix=f"thedaw_lora_{job_id[:8]}_"))
    paths: list[str] = []
    weights: list[float] = []
    for slot in slots:
        original = Path(
            getattr(slot.upload, "filename", f"lora_{slot.index}.safetensors")
        ).name
        stem = _condense_filename_text(Path(original).stem, f"lora_{slot.index}")
        suffix = Path(original).suffix or ".safetensors"
        dest = temp_dir / f"{slot.index:02d}_{stem}{suffix}"
        data = await slot.upload.read()
        dest.write_bytes(data)
        paths.append(str(dest))
        weights.append(slot.weight)

    return paths, weights, temp_dir


def _clear_generation_loras(generation_pipeline) -> None:
    """Remove request-scoped LoRA parametrizations from a cached pipeline."""
    from stable_audio_3.models.lora import remove_lora

    remove_lora(generation_pipeline.model)
    generation_pipeline.model.use_lora = False
    generation_pipeline.model.lora_names = []


def _fig_to_base64(fig: Figure) -> str:
    """Convert matplotlib Figure to base64 PNG string."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0, dpi=100)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


def _compute_request_sample_size(
    generation_pipeline,
    duration_sec: float,
    duration_padding_sec: float,
) -> int:
    """Compute an aligned sample_size from requested duration (+padding).

    StableAudioModel.generate() clamps adapted lengths to the provided sample_size.
    If we do not set this per request, it falls back to the model default (~120s).
    """
    output_sr = int(generation_pipeline.model_config.get("sample_rate", sample_rate))
    target_seconds = max(0.0, float(duration_sec)) + max(
        0.0, float(duration_padding_sec)
    )
    target_audio_samples = int(math.ceil(target_seconds * output_sr))

    pretransform = getattr(generation_pipeline.model, "pretransform", None)
    if pretransform is not None:
        ds_ratio = int(getattr(pretransform, "downsampling_ratio", 1))
    else:
        ds_ratio = 1

    align = max(1, ds_ratio)
    try:
        encoder_config = generation_pipeline.model_config["model"]["pretransform"][
            "config"
        ]["encoder"]["config"]
        chunk_size = int(encoder_config.get("chunk_size", 32))
        strides = encoder_config.get("strides", [1])
        stride = int(strides[0]) if strides else 1
        latent_align = max(1, chunk_size // max(1, stride))
        align = max(align, ds_ratio * latent_align)
    except (KeyError, TypeError, ValueError):
        pass

    if target_audio_samples <= 0:
        target_audio_samples = align

    if align > 1:
        target_audio_samples = ((target_audio_samples + align - 1) // align) * align

    max_sample_size_env = os.getenv("theDAW_MAX_SAMPLE_SIZE")
    if max_sample_size_env:
        try:
            max_sample_size = int(max_sample_size_env)
            if max_sample_size > 0:
                target_audio_samples = min(target_audio_samples, max_sample_size)
        except ValueError:
            logger.warning(
                "Invalid theDAW_MAX_SAMPLE_SIZE=%r (must be int)",
                max_sample_size_env,
            )

    return int(target_audio_samples)


async def _decode_audio_bytes(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode raw audio bytes to numpy array. Returns (waveform, sample_rate).

    Tries soundfile first (wav, flac, ogg), then falls back to torchaudio via temp file.
    Waveform shape: (channels, samples) as float32.
    """
    buf = io.BytesIO(audio_bytes)

    # Try soundfile first (handles wav, flac, ogg)
    try:
        import soundfile as sf

        waveform, sr = sf.read(buf)
        # Convert to float32, shape (channels, samples) or (samples,)
        waveform = waveform.astype(np.float32)
        if waveform.ndim == 1:
            waveform = waveform[None, :]  # (1, samples)
        else:
            waveform = waveform.T  # (channels, samples)
        return waveform, sr
    except Exception as e:
        logger.debug(f"soundfile decode failed, trying torchaudio: {e}")
        buf.seek(0)

    # Fallback: torchaudio via temp file
    import torchaudio

    fd, fname = tempfile.mkstemp(suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(audio_bytes)
        t, sr = torchaudio.load(fname)
        return t.numpy(), sr
    finally:
        try:
            os.unlink(fname)
        except Exception as e:
            logger.warning(f"Failed to delete temp audio file {fname}: {e}")


def _generate_mel(waveform: np.ndarray, sr: int) -> str:
    """Generate MEL spectrogram. Returns base64 PNG or empty string on error.

    Rendered with librosa + specshow like the other three types. The previous
    aeiou/torchaudio path double-applied dB conversion (AmplitudeToDB inside
    audio_spectrogram_image, then power_to_db again before imshow), clamping
    every pixel below vmin and producing a solid blank image.
    """
    try:
        import librosa
        import librosa.display
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.figure import Figure

        mono = waveform[0] if waveform.ndim > 1 else waveform
        S = librosa.feature.melspectrogram(
            y=mono, sr=sr, n_fft=2048, hop_length=512, n_mels=128
        )
        S_db = librosa.power_to_db(S, ref=np.max)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(
            S_db, sr=sr, x_axis="time", y_axis="mel", ax=ax, cmap="viridis"
        )
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"MEL spectrogram failed: {e}")
        return ""


def _generate_stft(waveform: np.ndarray, sr: int) -> str:
    """Generate STFT spectrogram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.figure import Figure

        mono = waveform[0] if waveform.ndim > 1 else waveform
        D = librosa.amplitude_to_db(np.abs(librosa.stft(mono)), ref=np.max)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(
            D, sr=sr, x_axis="time", y_axis="hz", ax=ax, cmap="viridis"
        )
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"STFT spectrogram failed: {e}")
        return ""


def _generate_chromagram(waveform: np.ndarray, sr: int) -> str:
    """Generate chromagram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.figure import Figure

        mono = waveform[0] if waveform.ndim > 1 else waveform
        chroma = librosa.feature.chroma_stft(y=mono, sr=sr)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(
            chroma, sr=sr, x_axis="time", y_axis="chroma", ax=ax, cmap="viridis"
        )
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"chromagram failed: {e}")
        return ""


def _generate_cqt(waveform: np.ndarray, sr: int) -> str:
    """Generate CQT spectrogram. Returns base64 PNG or empty string on error."""
    try:
        import librosa
        import librosa.display
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.figure import Figure

        mono = waveform[0] if waveform.ndim > 1 else waveform
        C = np.abs(librosa.cqt(mono, sr=sr))
        C_db = librosa.amplitude_to_db(C, ref=np.max)

        fig = Figure(figsize=(10, 3))
        ax = fig.add_subplot(111)
        librosa.display.specshow(
            C_db, sr=sr, x_axis="time", y_axis="cqt_note", ax=ax, cmap="viridis"
        )
        ax.set_axis_off()
        fig.tight_layout(pad=0)

        return _fig_to_base64(fig)
    except Exception as e:
        logger.warning(f"CQT spectrogram failed: {e}")
        return ""


def _generate_spectrograms(waveform: torch.Tensor, sr: int) -> dict[str, str]:
    """
    Generate all 4 spectrogram types from waveform tensor.
    Returns dict with base64 PNG strings: {mel, stft, chromagram, cqt}.
    Each type is independently fault-tolerant - returns empty string on error.
    """
    result = {"mel": "", "stft": "", "chromagram": "", "cqt": ""}

    # All four types render from the same mean-downmixed mono numpy array.
    try:
        if waveform.ndim > 1:
            y = waveform.mean(dim=0).cpu().numpy()
        else:
            y = waveform.cpu().numpy()

        result["mel"] = _generate_mel(y, sr)
        result["stft"] = _generate_stft(y, sr)
        result["chromagram"] = _generate_chromagram(y, sr)
        result["cqt"] = _generate_cqt(y, sr)

    except ImportError:
        logger.warning("librosa not installed - STFT, Chromagram, and CQT unavailable")
    except Exception as e:
        logger.warning(f"Librosa spectrogram generation failed: {e}")

    return result


@app.on_event("startup")
async def load_model():
    startup_t0 = time.perf_counter()

    # System stats (kept torch-free so server-ready never waits on the ~9.6s
    # torch/stable_audio_3 import; the GPU/torch line is logged by _warm_heavy
    # once the background warm finishes).
    try:
        import platform

        loaded_module_names = [m.get("name") for m in (app.state.loaded_modules or [])]
        logger.info(
            "startup: python=%s os=%s modules=%s",
            platform.python_version(),
            f"{platform.system()} {platform.release()}",
            ", ".join(loaded_module_names) if loaded_module_names else "(none)",
        )
    except Exception as e:
        logger.warning("startup: system-stat probe failed: %s", e)

    # Warm the heavy stack (torch + stable_audio_3) in the background AFTER the
    # port is bound, so the first generation is not cold while server-ready stays
    # fast. Models THEMSELVES still load on demand (single-resident policy): the
    # server must come up independently of any checkpoint.
    threading.Thread(target=_warm_heavy, name="warm-heavy", daemon=True).start()

    logger.info(
        "startup: server ready in %.2fs — generation models load on demand "
        "(default %r loads on first use)",
        time.perf_counter() - startup_t0,
        DEFAULT_GENERATION_MODEL,
    )

    # RAG indexing is LAZY: the embedding model + chroma client load on the first
    # assistant query (backend/rag.py retrieve()), not at startup, so a session
    # that never asks the assistant keeps that memory free.

    # Spin up the idle-gated background worker queue. It stays empty
    # until a feature (analysis / stems / midi) enqueues work.
    try:
        from backend.core.background_workers import get_background_queue

        get_background_queue().start()
        logger.info("startup: background worker queue started")
    except Exception as e:
        logger.warning("startup: background worker queue failed to start: %s", e)


@app.on_event("shutdown")
async def stop_background_workers() -> None:
    try:
        from backend.core.background_workers import get_background_queue

        await get_background_queue().stop()
    except Exception:
        # Shutdown is best-effort; never block process exit.
        pass


@app.get("/api/modules")
async def get_modules():
    return getattr(app.state, "loaded_modules", [])


@app.get("/api/modules/all")
async def get_all_modules():
    modules_dir = Path(__file__).parent / "modules"
    loaded_names = {m.get("name") for m in getattr(app.state, "loaded_modules", [])}
    result = []
    if modules_dir.is_dir():
        for module_dir in sorted(modules_dir.iterdir()):
            if not module_dir.is_dir():
                continue
            config_path = module_dir / "module.json"
            if config_path.exists():
                config = json.loads(config_path.read_text())
                config["_dir"] = module_dir.name
                config["_loaded"] = config.get("name") in loaded_names
                result.append(config)
    return result


@app.patch("/api/modules/{module_name}/enabled")
async def set_module_enabled(module_name: str, enabled: bool = Body(..., embed=True)):
    modules_dir = Path(__file__).parent / "modules"
    config_path = modules_dir / module_name / "module.json"
    if not config_path.exists():
        raise HTTPException(status_code=404, detail="Module not found")
    config = json.loads(config_path.read_text())
    config["enabled"] = enabled
    config_path.write_text(json.dumps(config, indent=2))
    config["_dir"] = module_name
    return config


@app.get("/api/system-stats")
async def system_stats():
    import torch

    stats: dict = {}
    if torch.cuda.is_available():
        stats["vram_used_gb"] = round(torch.cuda.memory_allocated() / 1024**3, 2)
        stats["vram_total_gb"] = round(
            torch.cuda.get_device_properties(0).total_memory / 1024**3, 2
        )
        try:
            r = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if r.returncode == 0:
                parts = [p.strip() for p in r.stdout.strip().split(",")]
                if len(parts) >= 2:
                    stats["gpu_util_pct"] = int(parts[0])
                    stats["gpu_temp_c"] = int(parts[1])
        except Exception:
            stats["gpu_util_pct"] = None
            stats["gpu_temp_c"] = None
    else:
        stats["vram_used_gb"] = 0
        stats["vram_total_gb"] = 0
        stats["gpu_util_pct"] = None
        stats["gpu_temp_c"] = None

    try:
        import psutil

        stats["cpu_pct"] = round(psutil.cpu_percent(interval=None))
        vm = psutil.virtual_memory()
        stats["ram_used_gb"] = round(vm.used / 1024**3, 1)
        stats["ram_total_gb"] = round(vm.total / 1024**3, 1)
    except Exception:
        stats["cpu_pct"] = None
        stats["ram_used_gb"] = None
        stats["ram_total_gb"] = None

    return stats


@app.get("/api/health")
async def health():
    return {"status": "ok", "model_loaded": pipeline is not None}


@app.get("/api/model-info")
async def model_info():
    # Lazy loading: the server runs model-free until first use, so this
    # endpoint reports metadata instead of erroring when nothing is loaded.
    import torch

    return {
        "model_loaded": pipeline is not None,
        "active_model": _active_model_name,
        "available_models": sorted(_generation_models()) + _registered_local_models(),
        "loaded_models": sorted(_generation_pipelines),
        "sample_rate": sample_rate,
        "diffusion_objective": (
            pipeline.model.diffusion_objective if pipeline else None
        ),
        "has_cuda": torch.cuda.is_available(),
        "device": str(pipeline.device) if pipeline else None,
        "vram_used_gb": (
            round(torch.cuda.memory_allocated() / 1024**3, 2)
            if torch.cuda.is_available()
            else 0
        ),
        "vram_total_gb": (
            round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2)
            if torch.cuda.is_available()
            else 0
        ),
    }


def _vram_used_gb() -> float:
    import torch

    return (
        round(torch.cuda.memory_allocated() / 1024**3, 2)
        if torch.cuda.is_available()
        else 0.0
    )


def _move_pipelines(device: str) -> int:
    """Move every loaded generation pipeline's weights to ``device`` (blocking).

    Run off the event loop. Moving a fp16 model GPU<->CPU is a pure tensor
    transfer (no dtype change, bit-identical weights), so an offload/onload
    round-trip restores the exact loaded state with no disk read.
    """
    import torch

    moved = 0
    with _model_move_lock:
        for pl in list(_generation_pipelines.values()):
            try:
                pl.model.to(device)
                pl.device = torch.device(device)
                moved += 1
            except Exception:
                logger.exception("model.move: failed moving a pipeline to %s", device)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            if device != "cpu":
                torch.cuda.synchronize()
    return moved


@app.post("/api/model/offload")
async def offload_model():
    """Park the SA3 model(s) in CPU RAM, freeing VRAM, without stopping the server.

    Non-destructive: the fully-loaded model stays in system RAM so a co-resident
    GPU workload (the Magenta RT2 sidecar) can use the card, and POST
    /api/model/onload swaps it straight back to the GPU in seconds with no disk
    reload. The backend process, API, and all non-DiT features stay up.
    """
    global _sa3_offloaded
    if _generation_job_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="A generation is in progress; the model swap will be possible "
            "once it finishes.",
        )
    before = _vram_used_gb()
    loop = asyncio.get_event_loop()
    n = await loop.run_in_executor(None, _move_pipelines, "cpu")
    _sa3_offloaded = True
    after = _vram_used_gb()
    logger.info(
        "model.offload: parked %d pipeline(s) in CPU RAM, torch VRAM %.2f -> %.2f GB",
        n,
        before,
        after,
    )
    return {
        "offloaded": n,
        "location": "cpu",
        "vram_used_gb_before": before,
        "vram_used_gb_after": after,
    }


@app.post("/api/model/onload")
async def onload_model():
    """Swap the SA3 model(s) back from CPU RAM to VRAM (reverse of /offload)."""
    import torch

    global _sa3_offloaded
    if _generation_job_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="A generation is in progress; the model swap will be possible "
            "once it finishes.",
        )
    target = "cuda" if torch.cuda.is_available() else "cpu"
    before = _vram_used_gb()
    loop = asyncio.get_event_loop()
    n = await loop.run_in_executor(None, _move_pipelines, target)
    _sa3_offloaded = False
    after = _vram_used_gb()
    logger.info(
        "model.onload: restored %d pipeline(s) to %s, torch VRAM %.2f -> %.2f GB",
        n,
        target,
        before,
        after,
    )
    return {
        "onloaded": n,
        "location": target,
        "vram_used_gb_before": before,
        "vram_used_gb_after": after,
    }


@app.get("/api/model/offload-status")
async def offload_status():
    """Report whether the SA3 model is currently parked in CPU RAM."""
    return {
        "offloaded": _sa3_offloaded,
        "active_model": _active_model_name,
        "loaded_models": sorted(_generation_pipelines),
        "vram_used_gb": _vram_used_gb(),
    }


@app.post("/api/model/load")
async def preload_model(model: str = Form(...)):
    """Pre-load a generation model so the first CREATE starts instantly.

    Same path the generate endpoints use: clears any resident MRT2 engine,
    then loads (or wakes) the requested pipeline. The request stays open for
    the duration of the load — minutes on a cold first load of medium.
    """
    if _generation_job_lock.locked():
        raise HTTPException(
            status_code=409,
            detail="A generation is running; the model can't be swapped right now.",
        )
    normalized = _normalize_generation_model(model)
    if normalized != (model or "").strip().lower():
        raise HTTPException(404, f"Unknown generation model {model!r}.")
    from backend.core.idle import get_idle_manager
    from stable_audio_3.model_configs import resolution_events, resolution_seq

    get_idle_manager().bump_activity(tag="model-load")
    loop = asyncio.get_event_loop()
    since = resolution_seq()
    t0 = time.perf_counter()
    await loop.run_in_executor(None, _ensure_gpu_clear_of_magenta)
    await loop.run_in_executor(None, _get_or_load_generation_pipeline, normalized)
    return {
        "loaded": True,
        "model": normalized,
        "seconds": round(time.perf_counter() - t0, 2),
        "device": str(pipeline.device) if pipeline else None,
        "vram_used_gb": _vram_used_gb(),
        # Exactly where every file came from (local folder / HF cache /
        # downloaded). Empty when the pipeline was already loaded or parked.
        "resolution": resolution_events(since),
    }


@app.post("/api/spectrogram")
async def generate_spectrogram(
    audio_base64: Optional[str] = Form(None),
    mime_type: str = Form("audio/wav"),
    sample_rate_form: int = Form(44100),
    audio_file: Optional[UploadFile] = File(None),
):
    """
    Generate spectrograms (MEL, STFT, Chromagram, CQT) from audio.
    Accepts either audio_base64 (string) OR audio_file (UploadFile).
    Returns JSON with base64 PNG strings for each spectrogram type.
    """
    import torch

    # Validate input
    if audio_base64 is None and audio_file is None:
        raise HTTPException(
            status_code=400, detail="Either audio_base64 or audio_file must be provided"
        )

    if audio_base64 is not None and audio_file is not None:
        raise HTTPException(
            status_code=400,
            detail="Provide either audio_base64 or audio_file, not both",
        )

    try:
        # Load audio
        if audio_file is not None:
            # Read from UploadFile
            audio_data = await audio_file.read()

            # Validate size (50MB limit)
            if len(audio_data) > 50 * 1024 * 1024:
                raise HTTPException(
                    status_code=413, detail="Audio file exceeds 50MB limit"
                )
        else:
            # Decode base64
            assert audio_base64 is not None
            audio_data = base64.b64decode(audio_base64)

            # Validate size (50MB limit)
            if len(audio_data) > 50 * 1024 * 1024:
                raise HTTPException(
                    status_code=413, detail="Audio data exceeds 50MB limit"
                )

        # Decode audio with robust fallback
        waveform_np, sr = await _decode_audio_bytes(audio_data)
        waveform = torch.from_numpy(waveform_np)

        # Generate spectrograms
        spectrograms = _generate_spectrograms(waveform, sr)

        return JSONResponse(spectrograms)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Spectrogram generation error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Failed to generate spectrograms: {str(e)}"
        )


@app.get("/api/spectrogram/{job_id}")
async def get_cached_spectrogram(job_id: str):
    """
    Retrieve cached spectrograms for a completed job.
    Returns 404 if job not found or spectrograms not cached.
    """
    if job_id not in _spec_cache:
        raise HTTPException(
            status_code=404, detail="Spectrograms not found for this job"
        )

    return JSONResponse(_spec_cache[job_id])


@app.get("/api/spectrogram/{job_id}/{index}")
async def get_cached_spectrogram_item(job_id: str, index: int):
    """Retrieve cached spectrograms for a specific generated item in a batch."""
    cache_key = f"{job_id}:{index}"
    if cache_key not in _spec_cache:
        raise HTTPException(
            status_code=404, detail="Spectrograms not found for this job item"
        )

    return JSONResponse(_spec_cache[cache_key])


async def _load_audio_upload(upload: UploadFile):
    """Read an uploaded audio file and return (sample_rate, tensor) tuple."""
    import torchaudio

    data = await upload.read()
    buf = io.BytesIO(data)
    waveform, sr = torchaudio.load(buf)
    return (sr, waveform)


@app.post("/api/generate")
async def generate(
    prompt: str = Form(...),
    negative_prompt: Optional[str] = Form(None),
    duration: float = Form(30.0),
    steps: int = Form(8),
    cfg_scale: float = Form(1.0),
    seed: int = Form(-1),
    sampler_type: Optional[str] = Form(None),
    sigma_max: float = Form(1.0),
    apg_scale: float = Form(1.0),
    duration_padding_sec: float = Form(6.0),
    cfg_rescale: float = Form(0.0),
    cfg_norm_threshold: float = Form(0.0),
    cfg_interval_min: float = Form(0.0),
    cfg_interval_max: float = Form(1.0),
    # Distribution shift
    dist_shift_type: Optional[str] = Form(None),
    logsnr_anchor_length: int = Form(2000),
    logsnr_anchor_logsnr: float = Form(-6.2),
    logsnr_rate: float = Form(1.0),
    logsnr_end: float = Form(2.0),
    flux_min_len: int = Form(256),
    flux_max_len: int = Form(4096),
    flux_alpha_min: float = Form(1.15),
    flux_alpha_max: float = Form(4.5),
    full_base_shift: float = Form(0.5),
    full_max_shift: float = Form(1.15),
    full_min_len: int = Form(256),
    full_max_len: int = Form(4096),
    # Init audio
    init_noise_level: float = Form(1.0),
    init_audio_type: str = Form("Audio"),
    # Inpainting
    mask_start: float = Form(0.0),
    mask_end: float = Form(0.0),
    # RF-Inversion
    inversion_steps: int = Form(8),
    inversion_gamma: float = Form(0.5),
    inversion_unconditional: str = Form("false"),
    # File format
    file_format: str = Form("wav"),
    # File uploads
    init_audio: Optional[UploadFile] = File(None),
    inpaint_audio: Optional[UploadFile] = File(None),
):
    import torch
    import torchaudio
    from stable_audio_3.inference.distribution_shift import (
        DistributionShift,
        FluxDistributionShift,
        LogSNRShift,
    )

    # lazy: load (or wake) the active model on first use; clear any resident
    # MRT2 engine first so SA3 never stacks on top of it (commit-limit crash)
    await asyncio.get_event_loop().run_in_executor(None, _ensure_gpu_clear_of_magenta)
    # Off the event loop (see /api/generate-jobs): a synchronous model load here
    # would block the single worker and stall /health + media streaming.
    generation_pipeline = await asyncio.get_event_loop().run_in_executor(
        None, _get_or_load_generation_pipeline, _active_model_name
    )

    # Build dist_shift object
    dist_shift = None
    if dist_shift_type and dist_shift_type not in ("None", "none", ""):
        if dist_shift_type == "LogSNR":
            dist_shift = LogSNRShift(
                anchor_length=logsnr_anchor_length,
                anchor_logsnr=logsnr_anchor_logsnr,
                rate=logsnr_rate,
                logsnr_end=logsnr_end,
            )
        elif dist_shift_type == "Flux":
            dist_shift = FluxDistributionShift(
                min_length=flux_min_len,
                max_length=flux_max_len,
                alpha_min=flux_alpha_min,
                alpha_max=flux_alpha_max,
            )
        elif dist_shift_type == "Full":
            dist_shift = DistributionShift(
                base_shift=full_base_shift,
                max_shift=full_max_shift,
                min_length=full_min_len,
                max_length=full_max_len,
            )

    # Load init audio if provided
    init_audio_tuple = None
    if init_audio is not None and init_audio.filename:
        init_audio_tuple = await _load_audio_upload(init_audio)
    init_audio_type = _validate_init_audio_mode(
        init_audio_type,
        has_init_audio=init_audio_tuple is not None,
    )

    # Load inpaint audio if provided
    inpaint_audio_tuple = None
    if inpaint_audio is not None and inpaint_audio.filename:
        inpaint_audio_tuple = await _load_audio_upload(inpaint_audio)

    generate_args = {
        "prompt": prompt,
        "negative_prompt": negative_prompt if negative_prompt else None,
        "duration": duration,
        "steps": steps,
        "cfg_scale": cfg_scale,
        "seed": seed,
        "apg_scale": apg_scale,
        "duration_padding_sec": duration_padding_sec,
        "scale_phi": cfg_rescale,
        "cfg_norm_threshold": cfg_norm_threshold,
        "cfg_interval": (cfg_interval_min, cfg_interval_max),
    }
    generate_args["sample_size"] = _compute_request_sample_size(
        generation_pipeline,
        duration,
        duration_padding_sec,
    )

    if sampler_type:
        generate_args["sampler_type"] = sampler_type
    if sigma_max != 1.0:
        generate_args["sigma_max"] = sigma_max
    if dist_shift is not None:
        generate_args["dist_shift"] = dist_shift

    # Init audio (audio-to-audio)
    if init_audio_tuple:
        generate_args["init_audio"] = init_audio_tuple
        generate_args["init_noise_level"] = init_noise_level

    # Inpainting
    if inpaint_audio_tuple:
        generate_args["inpaint_audio"] = inpaint_audio_tuple
        if mask_start > 0 or mask_end > 0:
            generate_args["inpaint_mask_start_seconds"] = mask_start
            generate_args["inpaint_mask_end_seconds"] = mask_end

    loop = asyncio.get_event_loop()

    def _do_generate():
        gen_audio = generation_pipeline.generate(**generate_args)
        gen_audio = gen_audio.to(torch.float32).clamp(-1, 1).squeeze(0).cpu()

        fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"

        buf = io.BytesIO()
        save_kwargs: dict = {}
        if fmt == "wav":
            save_kwargs.update(encoding="PCM_S", bits_per_sample=16)
        torchaudio.save(buf, gen_audio, sample_rate, format=fmt, **save_kwargs)
        buf.seek(0)
        return buf, fmt

    buffer, fmt = await loop.run_in_executor(None, _do_generate)

    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}

    return StreamingResponse(
        buffer,
        media_type=mime_map.get(fmt, "audio/wav"),
        headers={
            "Content-Disposition": f"attachment; filename=output_{seed}.{fmt}",
            "X-Seed": str(seed),
            "X-Duration": str(duration),
        },
    )


# --- Async job shim for theDAW frontend (generate-jobs + polling) ---

JOBS: dict[str, dict] = {}


def _generate_to_bytes(
    generation_pipeline, generate_args: dict, file_format: str, callback=None
) -> tuple[bytes, str]:
    import torch
    import torchaudio

    if callback:
        generate_args["callback"] = callback
    audio = generation_pipeline.generate(**generate_args)
    audio = audio.to(torch.float32).clamp(-1, 1).squeeze(0).cpu()
    fmt = file_format if file_format in ("wav", "flac", "ogg") else "wav"
    output_sample_rate = int(
        generation_pipeline.model_config.get("sample_rate", sample_rate)
    )
    buf = io.BytesIO()
    # Save as PCM_16 instead of the default 32-bit float for WAV outputs —
    # halves the on-disk footprint with no perceptible quality cost on
    # generative audio. FLAC handles its own efficient encoding.
    save_kwargs: dict = {}
    if fmt == "wav":
        save_kwargs.update(encoding="PCM_S", bits_per_sample=16)
    torchaudio.save(buf, audio, output_sample_rate, format=fmt, **save_kwargs)
    return buf.getvalue(), fmt


async def _run_generate_job(
    job_id: str,
    generation_pipeline,
    base_args: dict,
    batch_size: int,
    file_format: str,
    file_naming: str,
    custom_name: str,
    lora_paths: list[str],
    lora_weights: list[float],
    lora_temp_dir: Path | None,
):
    import torchaudio

    JOBS[job_id]["status"] = "running"
    loop = asyncio.get_event_loop()
    mime_map = {"wav": "audio/wav", "flac": "audio/flac", "ogg": "audio/ogg"}
    try:
        items = []
        async with _generation_job_lock:
            try:
                if lora_paths:
                    _clear_generation_loras(generation_pipeline)
                    generation_pipeline.load_lora(lora_paths)
                    for i, weight in enumerate(lora_weights):
                        generation_pipeline.set_lora_strength(weight, lora_index=i)

                seed_base = int(base_args.get("seed", -1))
                for i in range(max(1, batch_size)):
                    args = dict(base_args)
                    if batch_size > 1 and seed_base != -1:
                        args["seed"] = seed_base + i

                    def _step_callback(step_info):
                        # Ensure we update the job progress safely
                        if job_id in JOBS:
                            JOBS[job_id]["progress"]["step"] = step_info.get("i", 0) + 1

                    audio_bytes, fmt = await loop.run_in_executor(
                        None,
                        _generate_to_bytes,
                        generation_pipeline,
                        args,
                        file_format,
                        _step_callback,
                    )
                    mime_type = mime_map.get(fmt, "audio/wav")
                    filename = _make_generation_filename(
                        job_id,
                        i,
                        fmt,
                        file_naming,
                        str(base_args.get("prompt", "")),
                        base_args.get("negative_prompt"),
                        int(args.get("seed", -1)),
                        custom_name,
                    )

                    def _do_specs_and_save():
                        waveform, sr = torchaudio.load(io.BytesIO(audio_bytes))
                        spectrograms = _generate_spectrograms(waveform, sr)
                        artifact_info = _save_generation_artifacts_sync(
                            job_id=job_id,
                            index=i,
                            audio_bytes=audio_bytes,
                            audio_filename=filename,
                            mime_type=mime_type,
                            spectrograms=spectrograms,
                            metadata={
                                "model_name": JOBS[job_id].get("model_name"),
                                "prompt": base_args.get("prompt", ""),
                                "negative_prompt": base_args.get("negative_prompt"),
                                "duration": base_args.get("duration"),
                                "steps": args.get("steps"),
                                "cfg_scale": args.get("cfg_scale"),
                                "seed": args.get("seed"),
                            },
                        )
                        return spectrograms, artifact_info

                    spectrograms, artifact_info = await loop.run_in_executor(
                        None, _do_specs_and_save
                    )

                    # Post-save library sync: the generation flow writes
                    # the entry's files directly (not via LibraryStore),
                    # so we mirror it into SQLite here and enqueue
                    # background analysis if the user has the toggle on.
                    try:
                        from backend.modules.library.router import (
                            get_store as _get_library_store,
                        )
                        from backend.modules.library.store import (
                            _maybe_enqueue_analysis,
                            _maybe_enqueue_midi,
                            _maybe_enqueue_stems,
                        )

                        _lib_store = _get_library_store()
                        _entry_id = f"{job_id}_{i:02d}"
                        _record = _lib_store.get_entry(_entry_id)
                        if _record is not None and _lib_store.db is not None:
                            _entry_dir = _lib_store._dir_for(_entry_id)
                            _meta = (
                                json.loads(
                                    (_entry_dir / "metadata.json").read_text(
                                        encoding="utf-8"
                                    )
                                )
                                if _entry_dir
                                and (_entry_dir / "metadata.json").is_file()
                                else {}
                            )
                            _lib_store._sync_record_to_db(_record, _meta)
                            _maybe_enqueue_analysis(
                                _lib_store, _entry_id, source="generate"
                            )
                            _maybe_enqueue_stems(
                                _lib_store, _entry_id, source="generate"
                            )
                            _maybe_enqueue_midi(
                                _lib_store, _entry_id, source="generate"
                            )
                    except Exception as _e:
                        logger.debug(
                            "post-save library sync failed for %s_%02d: %s",
                            job_id,
                            i,
                            _e,
                        )

                    _add_to_spec_cache(f"{job_id}:{i}", spectrograms)
                    if i == 0:
                        _add_to_spec_cache(job_id, spectrograms)
                    items.append(
                        {
                            "audio_base64": base64.b64encode(audio_bytes).decode(
                                "ascii"
                            ),
                            "mime_type": mime_type,
                            "filename": filename,
                            "spectrograms": spectrograms,
                            **artifact_info,
                        }
                    )
            finally:
                if lora_paths:
                    _clear_generation_loras(generation_pipeline)

        if batch_size > 1:
            JOBS[job_id]["result"] = {"batch": True, "items": items}
        else:
            JOBS[job_id]["result"] = {"batch": False, "item": items[0]}
        JOBS[job_id]["artifact_dir"] = str(_get_generation_artifacts_root() / job_id)
        JOBS[job_id]["status"] = "completed"
        logger.info(
            "Saved generation artifacts for job %s in %s",
            job_id,
            JOBS[job_id]["artifact_dir"],
        )

    except Exception as e:
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["error"] = str(e)
    finally:
        if lora_temp_dir is not None:
            shutil.rmtree(lora_temp_dir, ignore_errors=True)
        # Release the idle gate so background workers can resume.
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("generate")
        except Exception:
            pass


@app.post("/api/generate-jobs")
async def generate_jobs(
    request: Request,
    model_name: str = Form("medium"),
    prompt: str = Form(...),
    negative_prompt: str = Form(""),
    duration: float = Form(30.0),
    steps: int = Form(8),
    cfg_scale: float = Form(1.0),
    seed: int = Form(-1),
    batch_size: int = Form(1),
    init_noise_level: float = Form(1.0),
    init_audio_type: str = Form("Audio"),
    file_format: str = Form("wav"),
    file_naming: str = Form("verbose"),
    custom_name: str = Form(""),
    mask_start: float = Form(0.0),
    mask_end: float = Form(0.0),
    sampler_type: Optional[str] = Form(None),
    sigma_max: float = Form(1.0),
    duration_padding_sec: float = Form(6.0),
    apg_scale: float = Form(1.0),
    cfg_rescale: float = Form(0.0),
    cfg_norm_threshold: float = Form(0.0),
    cfg_interval_min: float = Form(0.0),
    cfg_interval_max: float = Form(1.0),
    dist_shift_type: Optional[str] = Form(None),
    logsnr_anchor_length: int = Form(2000),
    logsnr_anchor_logsnr: float = Form(-6.2),
    logsnr_rate: float = Form(1.0),
    logsnr_end: float = Form(2.0),
    flux_min_len: int = Form(256),
    flux_max_len: int = Form(4096),
    flux_alpha_min: float = Form(1.15),
    flux_alpha_max: float = Form(4.5),
    full_base_shift: float = Form(0.5),
    full_max_shift: float = Form(1.15),
    full_min_len: int = Form(256),
    full_max_len: int = Form(4096),
    inversion_steps: int = Form(8),
    inversion_gamma: float = Form(0.5),
    inversion_unconditional: str = Form("false"),
    cut_to_duration: str = Form("true"),
    init_audio: Optional[UploadFile] = File(None),
    inpaint_audio: Optional[UploadFile] = File(None),
):
    from stable_audio_3.inference.distribution_shift import (
        DistributionShift,
        FluxDistributionShift,
        LogSNRShift,
    )

    # Models load lazily — the loader below brings the requested model up
    # (waking a parked one or loading from disk) on first use.

    # Hold the idle gate open until the generation task completes so
    # background workers don't compete for the GPU.
    from backend.core.idle import get_idle_manager

    get_idle_manager().bump_activity(tag="generate")

    normalized_model_name = _normalize_generation_model(model_name)
    # Clear any resident MRT2 engine before the SA3 load/wake — the reverse
    # swap must hold no matter who drives the model field (UI, assistant,
    # API callers, capture harnesses).
    await asyncio.get_event_loop().run_in_executor(None, _ensure_gpu_clear_of_magenta)
    # Load/wake the model in a worker thread, never on the event loop: a
    # synchronous from_pretrained here freezes the single uvicorn worker for the
    # whole load, which is exactly when /health 502s and in-flight FileResponse
    # streams (MIDI/audio) get truncated ("Invalid MIDI track chunk").
    generation_pipeline = await asyncio.get_event_loop().run_in_executor(
        None, _get_or_load_generation_pipeline, normalized_model_name
    )

    init_audio_tuple = None
    if init_audio is not None and init_audio.filename:
        init_audio_tuple = await _load_audio_upload(init_audio)

    normalized_init_audio_type = _validate_init_audio_mode(
        init_audio_type,
        has_init_audio=init_audio_tuple is not None,
    )

    inpaint_audio_tuple = None
    if inpaint_audio is not None and inpaint_audio.filename:
        inpaint_audio_tuple = await _load_audio_upload(inpaint_audio)

    dist_shift = None
    if dist_shift_type and dist_shift_type not in ("None", "none", ""):
        if dist_shift_type == "LogSNR":
            dist_shift = LogSNRShift(
                anchor_length=logsnr_anchor_length,
                anchor_logsnr=logsnr_anchor_logsnr,
                rate=logsnr_rate,
                logsnr_end=logsnr_end,
            )
        elif dist_shift_type == "Flux":
            dist_shift = FluxDistributionShift(
                min_length=flux_min_len,
                max_length=flux_max_len,
                alpha_min=flux_alpha_min,
                alpha_max=flux_alpha_max,
            )
        elif dist_shift_type == "Full":
            dist_shift = DistributionShift(
                base_shift=full_base_shift,
                max_shift=full_max_shift,
                min_length=full_min_len,
                max_length=full_max_len,
            )

    base_args: dict = {
        "prompt": prompt,
        "negative_prompt": negative_prompt or None,
        "duration": float(duration),
        "steps": int(steps),
        "cfg_scale": float(cfg_scale),
        "seed": int(seed),
        "apg_scale": float(apg_scale),
        "duration_padding_sec": float(duration_padding_sec),
        "scale_phi": float(cfg_rescale),
        "cfg_norm_threshold": float(cfg_norm_threshold),
        "cfg_interval": (float(cfg_interval_min), float(cfg_interval_max)),
        "truncate_output_to_duration": _coerce_form_bool(cut_to_duration),
    }
    base_args["sample_size"] = _compute_request_sample_size(
        generation_pipeline,
        float(duration),
        float(duration_padding_sec),
    )
    if sampler_type:
        base_args["sampler_type"] = sampler_type
    if sigma_max != 1.0:
        base_args["sigma_max"] = float(sigma_max)
    if dist_shift is not None:
        base_args["dist_shift"] = dist_shift
    if init_audio_tuple:
        base_args["init_audio"] = init_audio_tuple
        base_args["init_noise_level"] = float(init_noise_level)
    if inpaint_audio_tuple:
        base_args["inpaint_audio"] = inpaint_audio_tuple
        if mask_start > 0 or mask_end > 0:
            base_args["inpaint_mask_start_seconds"] = float(mask_start)
            base_args["inpaint_mask_end_seconds"] = float(mask_end)

    job_id = str(uuid.uuid4())
    lora_paths, lora_weights, lora_temp_dir = await _persist_lora_uploads(
        await request.form(),
        job_id,
    )
    JOBS[job_id] = {
        "id": job_id,
        "kind": "generate",
        "model_name": normalized_model_name,
        "init_audio_type": normalized_init_audio_type,
        "lora_count": len(lora_paths),
        "status": "queued",
        "progress": {"step": 0, "steps": int(steps)},
        "created_at": time.time(),
    }

    asyncio.create_task(
        _run_generate_job(
            job_id,
            generation_pipeline,
            base_args,
            int(batch_size),
            file_format,
            file_naming,
            custom_name,
            lora_paths,
            lora_weights,
            lora_temp_dir,
        )
    )

    return {"job": {"id": job_id}}


@app.get("/api/jobs")
async def list_jobs():
    # Summaries only: a completed generate job's "result" carries the
    # full base64 audio + spectrograms (megabytes per job), and the
    # training poller hits this list repeatedly. Payloads stay on the
    # per-job GET below, which is what the generate flow polls.
    return {
        "jobs": [
            {k: v for k, v in job.items() if k != "result"} for job in JOBS.values()
        ]
    }


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/autoencoder/info")
async def autoencoder_info():
    return {"available_autoencoders": [], "loaded_autoencoders": []}


@app.post("/api/jobs/train-lora")
async def train_lora_stub():
    raise HTTPException(
        status_code=501, detail="LoRA training not implemented in this backend."
    )


@app.post("/api/jobs/pre-encode")
async def pre_encode_stub():
    raise HTTPException(
        status_code=501, detail="Pre-encode not implemented in this backend."
    )


@app.post("/api/autoencoder/encode")
async def ae_encode_stub():
    raise HTTPException(
        status_code=501, detail="Autoencoder encode not implemented in this backend."
    )


@app.post("/api/autoencoder/decode")
async def ae_decode_stub():
    raise HTTPException(
        status_code=501, detail="Autoencoder decode not implemented in this backend."
    )


@app.get("/api/presets")
async def list_presets():
    return []


@app.post("/api/presets")
async def save_preset(preset: dict):
    return {"id": str(uuid.uuid4()), "saved": True}


app.include_router(assistant_router)
app.include_router(admin_router)
