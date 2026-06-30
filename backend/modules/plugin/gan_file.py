"""GanFile — read and write .gan web-plugin packages (ZIP).

Mirrors the container approach of .tasmo (manifest.json + payload in a ZIP,
version-checked on load), but the payload is a bundled web app (index.html +
assets) instead of a serialized music project.
"""

from __future__ import annotations

import json
import logging
import zipfile
from pathlib import Path
from datetime import datetime, timezone

from backend.modules.plugin.gan_manifest import GanManifest

log = logging.getLogger(__name__)

GAN_COMMENT = b"GANv1"
CURRENT_FORMAT_VERSION = 1
SOFT_SIZE_WARN_BYTES = 200 * 1024 * 1024  # 200 MB

# Assets carrying these names are reserved/handled separately.
_MANIFEST_NAME = "manifest.json"


class GanFile:
    """Read and write .gan plugin files."""

    @staticmethod
    def save(manifest: GanManifest, assets: dict[str, bytes], path: str) -> dict:
        """Write a .gan file. ``assets`` maps in-zip paths (e.g. ``index.html``,
        ``background.png``) to bytes. Returns the manifest dict that was written.
        """
        now = datetime.now(timezone.utc).isoformat()
        if not manifest.created_at:
            manifest.created_at = now
        manifest.modified_at = now
        manifest.format_version = CURRENT_FORMAT_VERSION
        manifest_dict = manifest.model_dump()

        total_size = 0
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.comment = GAN_COMMENT
            zf.writestr(_MANIFEST_NAME, json.dumps(manifest_dict, indent=2))
            for name, data in assets.items():
                if name == _MANIFEST_NAME:
                    continue
                zf.writestr(name, data)
                total_size += len(data)

        if total_size > SOFT_SIZE_WARN_BYTES:
            log.warning(
                "Large .gan file: %d MB (soft warn at %d MB).",
                total_size // (1024 * 1024),
                SOFT_SIZE_WARN_BYTES // (1024 * 1024),
            )
        return manifest_dict

    @staticmethod
    def info(path: str) -> dict:
        """Read only the manifest from a .gan (no asset extraction)."""
        if not Path(path).is_file():
            raise FileNotFoundError(f".gan file not found: {path}")
        with zipfile.ZipFile(path, "r") as zf:
            try:
                manifest = json.loads(zf.read(_MANIFEST_NAME))
            except KeyError:
                raise ValueError("Invalid .gan: missing manifest.json")
        fv = manifest.get("format_version", 1)
        if fv > CURRENT_FORMAT_VERSION:
            raise ValueError(
                f"This .gan uses format v{fv}, but theDAW supports up to "
                f"v{CURRENT_FORMAT_VERSION}. Please update theDAW."
            )
        return manifest

    @staticmethod
    def load(path: str) -> tuple[dict, dict[str, bytes]]:
        """Read a .gan fully. Returns (manifest, assets) where assets maps
        in-zip path -> bytes (excluding manifest.json)."""
        manifest = GanFile.info(path)
        assets: dict[str, bytes] = {}
        with zipfile.ZipFile(path, "r") as zf:
            for name in zf.namelist():
                if name == _MANIFEST_NAME or name.endswith("/"):
                    continue
                assets[name] = zf.read(name)
        return manifest, assets

    @staticmethod
    def extract(path: str, out_dir: str) -> dict:
        """Extract a .gan's assets to ``out_dir`` for static serving. Returns the
        manifest dict. Guards against zip-slip path traversal."""
        manifest = GanFile.info(path)
        out = Path(out_dir).resolve()
        out.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "r") as zf:
            for name in zf.namelist():
                if name == _MANIFEST_NAME or name.endswith("/"):
                    continue
                dest = (out / name).resolve()
                if not str(dest).startswith(str(out)):
                    log.warning("Skipping unsafe .gan entry: %s", name)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(name))
        (out / _MANIFEST_NAME).write_text(json.dumps(manifest, indent=2))
        return manifest
