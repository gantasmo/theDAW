"""App-wide feature settings persisted to ``data/settings.json``.

This is the source of truth for background workflows: auto-analysis,
auto-stems, auto-midi. Analysis and stems are default-on so imported /
generated tracks are DJ-ready without extra clicks; MIDI remains opt-in.

The on-disk schema is versioned (``schema_version``) so we can migrate
fields forward without losing the user's existing choices. Missing keys
are filled from ``DEFAULT_SETTINGS`` on every load — partial files are
fine.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


SCHEMA_VERSION = 7


DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "app": {
        # How theDAW opens on the next launch (read by theDAW.bat before it
        # starts anything): "web" = backend + Vite + browser (current default),
        # "desktop" = the Electron shell. Both share the same backend + DB.
        "launch_mode": "web",
    },
    "analysis": {
        # Analysis is cheap (local librosa + aubio), so it's default-ON
        # — every imported / generated track gets its bpm/key/pitch/bars
        # written into the DB + Details panel without the user opting in.
        "auto_on_import": True,
        "auto_on_generate": True,
        "include_genre": False,
        "include_key": True,
    },
    "stems": {
        # Heavy, but DJ mode expects separated stems to be ready by default.
        # Users can still turn this off from Settings → Background features.
        "auto_on_import": True,
        "auto_on_generate": True,
        "default_count": 4,
        # 'cuda' | 'cpu' | 'auto'. The integration-package's sidecar
        # respects this query param. Default cuda because demucs on cpu
        # is multiple-minutes-per-track even on fast hosts.
        "device": "cuda",
        # 'fast' | 'balanced' | 'hq'. Forwarded to the sidecar's `quality`
        # query param. Default 'balanced' because the integration-package's
        # 'hq' preset (overlap=0.9, shifts=10) commonly takes 10+ minutes
        # per track on a 6 GB GPU and frequently hangs at single percent
        # points while it grinds through individual shifts.
        "quality": "balanced",
    },
    "midi": {
        # Requires basic-pitch / piano-transcription-inference. Opt-in.
        "auto_on_import": False,
        "auto_on_generate": False,
        "from_stems": True,
    },
    "idle": {
        "min_idle_seconds": 30,
        "respect_vram_pressure": True,
    },
    "vj": {
        # Root folder for VJ recording exports. A relative path resolves
        # against the project root; an absolute path is used verbatim.
        # Each take also lands in a per-export subfolder named in the VJ
        # record bar, so the final file is <export_root>/<subfolder>/…
        "export_root": "exports/vj",
    },
    "notation": {
        # Global artist/composer name. Stamped as the composer credit on every
        # generated sheet (and appended to song titles). Defaults to GANTASMO;
        # editable in Settings. The engine falls back to GANTASMO even if this
        # is blanked, so a sheet is never credited to "Music21".
        "artist": "GANTASMO",
    },
}


def default_settings_path(project_root: Path) -> Path:
    """Resolve the settings file path. Env override wins; otherwise it lives
    next to the library generations directory."""
    configured = os.getenv("theDAW_SETTINGS_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    return project_root / "data" / "settings.json"


def _merge_defaults(payload: dict[str, Any]) -> dict[str, Any]:
    """Fill missing top-level sections / keys from DEFAULT_SETTINGS without
    overwriting anything the user already set.

    Runs schema migrations on the way through:
      - v1 → v2: analysis.auto_on_import / auto_on_generate become
        default-ON because analysis is local and cheap. Any user who
        opened the app on a v1 build has the legacy off/off state; we
        flip them to on/on once during the upgrade.
    """
    merged = deepcopy(DEFAULT_SETTINGS)
    if not isinstance(payload, dict):
        return merged

    raw_version = payload.get("schema_version")
    try:
        old_version = int(raw_version) if isinstance(raw_version, (int, float)) else 0
    except (TypeError, ValueError):
        old_version = 0

    for section, value in payload.items():
        if section == "schema_version":
            continue
        if isinstance(value, dict) and isinstance(merged.get(section), dict):
            merged[section].update(
                {k: v for k, v in value.items() if k in merged[section]}
            )
        else:
            merged[section] = value

    if old_version < 2:
        # Migration v1 → v2: turn analysis on. Users who had it off can
        # flip it back via Settings → Background features.
        merged["analysis"]["auto_on_import"] = True
        merged["analysis"]["auto_on_generate"] = True
    if old_version < 3:
        # Migration v2 → v3: stems gain an explicit `device` field;
        # default cuda so a user who already enabled stems doesn't
        # silently fall through to cpu.
        merged["stems"]["device"] = "cuda"
    if old_version < 4:
        # Migration v3 → v4: stems gain a `quality` preset (default
        # 'balanced'). hq is the integration-package's old default but
        # it routinely hangs at ~5-10 min per track even on GPU; users
        # who want max quality can opt in via Settings → Stems.
        merged["stems"]["quality"] = "balanced"
    if old_version < 5:
        # Migration v4 → v5: add the `vj` section (export_root). New
        # section, so it's already filled from DEFAULT_SETTINGS above;
        # this branch only exists to re-persist the bumped schema.
        merged.setdefault("vj", deepcopy(DEFAULT_SETTINGS["vj"]))
    if old_version < 6:
        # Migration v5 → v6: make auto-stems default-on so DJ imports
        # start separating in the background without a manual stem click.
        # Also add the `app` section (launch_mode). Users who prefer lighter
        # imports can flip stems back in Settings.
        merged["stems"]["auto_on_import"] = True
        merged["stems"]["auto_on_generate"] = True
        merged.setdefault("app", deepcopy(DEFAULT_SETTINGS["app"]))
    if old_version < 7:
        # Migration v6 → v7: add the `notation` section (artist). New section,
        # already filled from DEFAULT_SETTINGS above; re-persist the bump.
        merged.setdefault("notation", deepcopy(DEFAULT_SETTINGS["notation"]))

    merged["schema_version"] = SCHEMA_VERSION
    return merged


class SettingsStore:
    """Thread-safe JSON-file settings store. Loads on init, writes atomically
    on every update via tempfile + replace."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._cache: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            payload = deepcopy(DEFAULT_SETTINGS)
            self._write(payload)
            return payload
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning(
                "settings.store: failed to read %s: %s — using defaults", self.path, e
            )
            return deepcopy(DEFAULT_SETTINGS)
        merged = _merge_defaults(raw)
        # Persist the post-migration shape so future loads start clean.
        prev_version = raw.get("schema_version") if isinstance(raw, dict) else None
        if prev_version != merged.get("schema_version"):
            try:
                self._write(merged)
            except OSError as e:
                log.warning("settings.store: failed to persist migrated schema: %s", e)
        return merged

    def _write(self, payload: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def get_all(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._cache)

    def get_section(self, section: str) -> dict[str, Any]:
        with self._lock:
            value = self._cache.get(section, {})
            return deepcopy(value) if isinstance(value, dict) else {}

    def get_value(self, section: str, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._cache.get(section, {}).get(key, default)

    def patch(self, patch_payload: dict[str, Any]) -> dict[str, Any]:
        """Merge a partial settings payload into the current state and persist.
        Only sections/keys already present in DEFAULT_SETTINGS are accepted —
        unknown keys are silently ignored to keep the on-disk shape stable.
        """
        with self._lock:
            for section, value in patch_payload.items():
                if section == "schema_version":
                    continue
                if section not in DEFAULT_SETTINGS:
                    continue
                target = self._cache.setdefault(section, {})
                if not isinstance(value, dict):
                    continue
                allowed_keys = set(DEFAULT_SETTINGS[section].keys())
                for k, v in value.items():
                    if k not in allowed_keys:
                        continue
                    target[k] = v
            self._cache["schema_version"] = SCHEMA_VERSION
            self._write(self._cache)
            return deepcopy(self._cache)
