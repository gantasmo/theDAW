"""VST3 plugin scanner — discovers VST3 plugins on the filesystem.

Scans the standard VST3 directories per platform, plus any user-specified
paths. Results are cached on disk so subsequent scans are instant unless
the user requests a refresh.
"""

from __future__ import annotations
import json
import logging
import os
import platform
import time
from pathlib import Path
from dataclasses import dataclass, asdict

log = logging.getLogger(__name__)


@dataclass
class Vst3PluginInfo:
    """Metadata for a discovered VST3 plugin."""

    name: str
    path: str
    manufacturer: str = ""
    version: str = ""
    category: str = ""  # "effect" | "instrument" | "unknown"
    file_size_mb: float = 0.0
    last_modified: float = 0.0


def _default_vst3_dirs() -> list[Path]:
    """Return the standard VST3 search paths for the current platform."""
    system = platform.system()
    dirs: list[Path] = []
    if system == "Windows":
        common = os.environ.get("COMMONPROGRAMFILES", r"C:\Program Files\Common Files")
        common_x86 = os.environ.get(
            "COMMONPROGRAMFILES(X86)", r"C:\Program Files (x86)\Common Files"
        )
        dirs.append(Path(common) / "VST3")
        dirs.append(Path(common_x86) / "VST3")
    elif system == "Darwin":
        dirs.append(Path("/Library/Audio/Plug-Ins/VST3"))
        dirs.append(Path.home() / "Library" / "Audio" / "Plug-Ins" / "VST3")
    else:
        dirs.append(Path("/usr/lib/vst3"))
        dirs.append(Path("/usr/local/lib/vst3"))
        dirs.append(Path.home() / ".vst3")
    return [d for d in dirs if d.is_dir()]


def scan_vst3_directories(extra_paths: list[str] | None = None) -> list[Vst3PluginInfo]:
    """Scan all standard (and optional extra) VST3 directories."""
    search_dirs = _default_vst3_dirs()
    if extra_paths:
        for p in extra_paths:
            candidate = Path(p)
            if candidate.is_dir():
                search_dirs.append(candidate)
    plugins: list[Vst3PluginInfo] = []
    seen: set[str] = set()
    for search_dir in search_dirs:
        try:
            for item in search_dir.rglob("*.vst3"):
                abs_path = str(item.resolve())
                if abs_path in seen:
                    continue
                seen.add(abs_path)
                name = item.stem
                manufacturer, version, category = "", "", "unknown"
                moduleinfo = item / "Contents" / "moduleinfo.json"
                if moduleinfo.is_file():
                    try:
                        mi = json.loads(moduleinfo.read_text(encoding="utf-8"))
                        plgs = mi.get("plugins", [])
                        if plgs:
                            manufacturer = plgs[0].get("vendor", "")
                            version = plgs[0].get("version", "")
                            cat = plgs[0].get("category", "")
                            if "Instrument" in cat:
                                category = "instrument"
                            elif "Fx" in cat:
                                category = "effect"
                    except Exception:
                        pass
                total_size = sum(
                    f.stat().st_size for f in item.rglob("*") if f.is_file()
                )
                last_mod = item.stat().st_mtime if item.exists() else 0.0
                plugins.append(
                    Vst3PluginInfo(
                        name=name,
                        path=abs_path,
                        manufacturer=manufacturer,
                        version=version,
                        category=category,
                        file_size_mb=round(total_size / (1024 * 1024), 1),
                        last_modified=last_mod,
                    )
                )
        except PermissionError:
            log.warning("Permission denied scanning VST3 dir: %s", search_dir)
        except Exception as e:
            log.warning("Error scanning VST3 dir %s: %s", search_dir, e)
    plugins.sort(key=lambda p: p.name.lower())
    return plugins


# --- Scan result cache ---
_CACHE_FILENAME = "vst3_scan_cache.json"


def _cache_path() -> Path:
    return Path(__file__).parent / _CACHE_FILENAME


def load_cached_scan() -> list[Vst3PluginInfo] | None:
    cp = _cache_path()
    if not cp.is_file():
        return None
    try:
        data = json.loads(cp.read_text(encoding="utf-8"))
        return [Vst3PluginInfo(**p) for p in data.get("plugins", [])]
    except Exception as e:
        log.debug("VST3 scan cache unreadable: %s", e)
        return None


def save_scan_cache(plugins: list[Vst3PluginInfo]) -> None:
    cp = _cache_path()
    try:
        cp.write_text(
            json.dumps(
                {"scanned_at": time.time(), "plugins": [asdict(p) for p in plugins]},
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("Failed to save VST3 scan cache: %s", e)
